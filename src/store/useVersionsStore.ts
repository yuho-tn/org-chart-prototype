import { create } from "zustand";
import {
  supabase,
  isSupabaseConfigured,
  type VersionRow,
  type VersionGrants,
} from "../lib/supabase";
import type { OrgNode } from "../lib/types";
import { useVersionsRealtime } from "./useVersionsRealtime";

/**
 * Progressive column sets used by every "select org_versions" query. We try
 * the most-complete one first; if Postgres reports a column doesn't exist
 * (i.e. some migration hasn't been run on this Supabase project), we retry
 * with progressively smaller sets so the app keeps working — but critically
 * we only drop the columns that are actually missing so flags like
 * is_confirmed don't get silently stripped just because permission columns
 * (0001) are missing. Order: full → no-permissions → no-permissions-no-fix
 * → minimal.
 */
const SELECT_TIERS = [
  "id, name, author, note, created_at, updated_at, created_by_email, is_private, grants, is_confirmed, confirmed_period, rev, is_default",
  "id, name, author, note, created_at, updated_at, is_confirmed, confirmed_period",
  "id, name, author, note, created_at, is_confirmed, confirmed_period",
  "id, name, author, note, created_at, updated_at",
  "id, name, author, note, created_at",
] as const;

const PERM_COLS_RE = /column .*(created_by_email|is_private|grants).* does not exist/i;
const EDITING_COLS_RE = /column .*(rev|is_default).* does not exist/i;
const FIX_COLS_RE = /column .*(is_confirmed|confirmed_period).* does not exist/i;
const UPDATED_AT_RE = /column .*updated_at.* does not exist/i;

function pickNextTier(
  current: number,
  errorMessage: string,
): number | null {
  if (EDITING_COLS_RE.test(errorMessage)) {
    // 0027 未適用: rev / is_default を含まない tier へ落とす。
    if (current < 1) return 1;
  }
  if (PERM_COLS_RE.test(errorMessage)) {
    // Drop permission columns: jump to the first tier that has none.
    if (current < 1) return 1;
  }
  if (FIX_COLS_RE.test(errorMessage)) {
    // Drop confirmation columns too: skip to the no-fix tier.
    if (current < 3) return 3;
  }
  if (UPDATED_AT_RE.test(errorMessage)) {
    if (current < 4) return 4;
  }
  // Generic "column X does not exist" we couldn't classify — step to the
  // next tier so we still have a chance of recovering.
  if (current + 1 < SELECT_TIERS.length) return current + 1;
  return null;
}

type VersionsState = {
  versions: VersionRow[];
  loading: boolean;
  error: string | null;

  /** Loads version metadata. Snapshot bodies are loaded on demand via getSnapshot(). */
  refresh: () => Promise<void>;
  /** Saves a new version. Returns the new VersionRow on success. */
  save: (input: {
    name: string;
    author: string;
    note: string | null;
    nodes: OrgNode[];
    created_by_email?: string | null;
    is_private?: boolean;
    grants?: VersionGrants;
  }) => Promise<VersionRow | null>;
  /** Overwrite an existing file's nodes (the file-model "保存"). 0027 以降は
   *  SECURITY DEFINER RPC（org_save_snapshot）経由: 生きた他人ロックの拒否と
   *  expected_rev 照合で後勝ち上書きを根絶する。expectedRev には「この編集の
   *  元になったサーバ rev」（useOrgStore.baseRev）を渡すこと。 */
  updateSnapshot: (
    id: string,
    nodes: OrgNode[],
    opts?: {
      expectedRev?: number | null;
      patch?: Partial<Pick<VersionRow, "name" | "note">>;
    },
  ) => Promise<
    | { ok: true; row: VersionRow; rev: number }
    | { ok: false; reason: string; lockedBy?: string; serverRev?: number }
  >;
  /** 公式デフォルト組織図の付替え（admin以上・RPC）。id=null で解除。 */
  setDefault: (id: string | null) => Promise<{ ok: boolean; reason?: string }>;
  /** Duplicate an existing file: copies snapshot+name and inserts as a fresh
   *  row owned by the current user. Confirmation flags are NOT copied — the
   *  duplicate always lands as a draft. */
  duplicate: (
    id: string,
    nameOverride: string,
    author: string,
    created_by_email: string | null,
  ) => Promise<VersionRow | null>;
  /** Updates only the permission columns for a version. */
  updatePermissions: (
    id: string,
    patch: { is_private?: boolean; grants?: VersionGrants },
  ) => Promise<boolean>;
  /** Renames a file. Returns true on confirmed DB write, false otherwise. */
  rename: (id: string, newName: string) => Promise<boolean>;
  /** Promote a draft version to a confirmed monthly snapshot, OR demote it
   *  back to a draft (period=null, is_confirmed=false). */
  setConfirmation: (
    id: string,
    patch: { is_confirmed: boolean; confirmed_period: string | null },
  ) => Promise<boolean>;
  /** Returns the snapshot nodes + server rev for a given version id. */
  getSnapshot: (id: string) => Promise<{ nodes: OrgNode[]; rev: number } | null>;
  /** Deletes a version by id. */
  remove: (id: string) => Promise<boolean>;
};

export const useVersionsStore = create<VersionsState>((set, get) => ({
  versions: [],
  loading: false,
  error: null,

  refresh: async () => {
    if (!supabase) {
      set({ error: "Supabaseが設定されていません" });
      return;
    }
    set({ loading: true, error: null });
    let tier = 0;
    let resp: { data: unknown; error: { message: string } | null } | null = null;
    while (tier < SELECT_TIERS.length) {
      resp = (await supabase
        .from("org_versions")
        .select(SELECT_TIERS[tier])
        .order("created_at", { ascending: false })
        .limit(100)) as { data: unknown; error: { message: string } | null };
      if (!resp.error) break;
      const next = pickNextTier(tier, resp.error.message);
      if (next === null) break;
      tier = next;
    }
    if (!resp || resp.error) {
      set({ loading: false, error: resp?.error?.message ?? "読み込みに失敗しました" });
      return;
    }
    set({ loading: false, versions: ((resp.data ?? []) as VersionRow[]) });
  },

  save: async ({ name, author, note, nodes, created_by_email, is_private, grants }) => {
    if (!supabase) {
      set({ error: "Supabaseが設定されていません" });
      return null;
    }
    // Strip optional cols from the INSERT payload by tier so the body
    // matches the SELECT we'll attempt — otherwise inserting `is_private`
    // into a DB that doesn't have that column fails before we ever reach
    // the SELECT-tier fallback.
    function payloadForTier(t: number): Record<string, unknown> {
      const cols = SELECT_TIERS[t];
      const has = (c: string) => cols.includes(c);
      const out: Record<string, unknown> = { name, author, note, snapshot: { nodes } };
      if (has("created_by_email") && created_by_email !== undefined) out.created_by_email = created_by_email;
      if (has("is_private") && is_private !== undefined) out.is_private = is_private;
      if (has("grants") && grants !== undefined) out.grants = grants;
      return out;
    }

    // .maybeSingle() is critical here: when an RLS policy on the table denies
    // the SELECT-after-INSERT (a common misconfiguration) PostgREST returns
    // 0 rows. .single() throws "Cannot coerce the result to a single JSON
    // object"; .maybeSingle() returns data: null and lets us recover.
    let tier = 0;
    let resp: { data: unknown; error: { message: string } | null } | null = null;
    while (tier < SELECT_TIERS.length) {
      resp = (await supabase
        .from("org_versions")
        .insert(payloadForTier(tier))
        .select(SELECT_TIERS[tier])
        .maybeSingle()) as { data: unknown; error: { message: string } | null };
      if (!resp.error) break;
      const next = pickNextTier(tier, resp.error.message);
      if (next === null) break;
      tier = next;
    }
    if (!resp || resp.error) {
      set({ error: resp?.error?.message ?? "保存に失敗しました" });
      return null;
    }
    if (!resp.data) {
      set({
        error:
          "保存はされた可能性がありますが、結果を取得できませんでした。Supabaseの行レベルセキュリティ（RLS）で SELECT が許可されているかご確認ください。",
      });
      return null;
    }
    const row = resp.data as VersionRow;
    set({ versions: [row, ...get().versions] });
    useVersionsRealtime.getState().markSelfSave(row.id, row.updated_at);
    useVersionsRealtime.getState().broadcastChange({
      kind: "created",
      versionId: row.id,
      name: row.name,
    });
    return row;
  },

  updateSnapshot: async (id, nodes, opts) => {
    if (!supabase) return { ok: false, reason: "supabase_unconfigured" };

    // 0027: スナップショット保存は RPC 経由（ロック検証＋rev照合）。
    const { data, error } = await supabase.rpc("org_save_snapshot", {
      p_version_id: id,
      p_snapshot: { nodes },
      p_expected_rev: opts?.expectedRev ?? null,
    });
    if (error) {
      // 0027 未適用環境では RPC が存在しない → 旧経路（直接UPDATE）へ退避。
      const missing = /function .*org_save_snapshot.* does not exist|Could not find the function/i.test(
        error.message,
      );
      if (!missing) {
        set({ error: error.message });
        return { ok: false, reason: error.message };
      }
      const { error: updErr } = await supabase
        .from("org_versions")
        .update({ snapshot: { nodes } })
        .eq("id", id);
      if (updErr) {
        set({ error: updErr.message });
        return { ok: false, reason: updErr.message };
      }
    } else {
      const res = (data ?? {}) as {
        ok?: boolean;
        reason?: string;
        locked_by?: string;
        server_rev?: number;
        rev?: number;
      };
      if (!res.ok) {
        return {
          ok: false,
          reason: res.reason ?? "unknown",
          lockedBy: res.locked_by,
          serverRev: res.server_rev,
        };
      }
    }

    // 任意のメタデータ変更（name/note）は従来どおり直接 UPDATE（RLS適用）。
    const patch: Record<string, unknown> = {};
    if (opts?.patch?.name !== undefined) patch.name = opts.patch.name;
    if (opts?.patch?.note !== undefined) patch.note = opts.patch.note;
    if (Object.keys(patch).length > 0) {
      await supabase.from("org_versions").update(patch).eq("id", id);
    }

    // 保存後の行を tier フォールバック付きで再取得し、ローカルキャッシュ更新。
    let tier = 0;
    let resp: { data: unknown; error: { message: string } | null } | null = null;
    while (tier < SELECT_TIERS.length) {
      resp = (await supabase
        .from("org_versions")
        .select(SELECT_TIERS[tier])
        .eq("id", id)
        .maybeSingle()) as { data: unknown; error: { message: string } | null };
      if (!resp.error) break;
      const next = pickNextTier(tier, resp.error.message);
      if (next === null) break;
      tier = next;
    }
    const fetched = (resp?.data as VersionRow | null) ?? null;
    const existing = get().versions.find((v) => v.id === id);
    const merged: VersionRow | null = fetched
      ? existing
        ? { ...existing, ...fetched }
        : fetched
      : existing
        ? { ...existing, updated_at: new Date().toISOString() }
        : null;
    if (!merged) return { ok: false, reason: "row_not_visible" };
    set({ versions: get().versions.map((v) => (v.id === id ? merged : v)) });
    useVersionsRealtime.getState().markSelfSave(id, merged.updated_at);
    useVersionsRealtime.getState().broadcastChange({
      kind: "saved",
      versionId: id,
      name: merged.name,
    });
    return { ok: true, row: merged, rev: merged.rev ?? 0 };
  },

  setDefault: async (id) => {
    if (!supabase) return { ok: false, reason: "supabase_unconfigured" };
    const { data, error } = await supabase.rpc("org_set_default", {
      p_version_id: id,
    });
    if (error) return { ok: false, reason: error.message };
    const res = (data ?? {}) as { ok?: boolean; reason?: string };
    if (!res.ok) return { ok: false, reason: res.reason };
    set({
      versions: get().versions.map((v) => ({ ...v, is_default: v.id === id })),
    });
    return { ok: true };
  },

  duplicate: async (id, nameOverride, author, created_by_email) => {
    if (!supabase) return null;
    const { data: src, error: srcErr } = await supabase
      .from("org_versions")
      .select("snapshot, note")
      .eq("id", id)
      .maybeSingle();
    if (srcErr || !src) {
      set({ error: srcErr?.message ?? "複製元の取得に失敗しました" });
      return null;
    }
    const noteVal = (src as { note: string | null }).note;
    const snapshotVal = (src as { snapshot: unknown }).snapshot;
    function payloadForTier(t: number): Record<string, unknown> {
      const cols = SELECT_TIERS[t];
      const has = (c: string) => cols.includes(c);
      const out: Record<string, unknown> = {
        name: nameOverride,
        author,
        note: noteVal,
        snapshot: snapshotVal,
      };
      if (has("created_by_email")) out.created_by_email = created_by_email;
      if (has("is_private")) out.is_private = false;
      if (has("grants")) out.grants = {};
      if (has("is_confirmed")) out.is_confirmed = false;
      if (has("confirmed_period")) out.confirmed_period = null;
      return out;
    }

    let tier = 0;
    let resp: { data: unknown; error: { message: string } | null } | null = null;
    while (tier < SELECT_TIERS.length) {
      resp = (await supabase
        .from("org_versions")
        .insert(payloadForTier(tier))
        .select(SELECT_TIERS[tier])
        .maybeSingle()) as { data: unknown; error: { message: string } | null };
      if (!resp.error) break;
      const next = pickNextTier(tier, resp.error.message);
      if (next === null) break;
      tier = next;
    }
    if (!resp || resp.error) {
      set({ error: resp?.error?.message ?? "複製に失敗しました" });
      return null;
    }
    if (!resp.data) {
      set({ error: "複製に失敗しました（結果が返却されませんでした）" });
      return null;
    }
    const row = resp.data as VersionRow;
    set({ versions: [row, ...get().versions] });
    return row;
  },

  rename: async (id, newName) => {
    if (!supabase) return false;
    const trimmed = newName.trim();
    if (!trimmed) {
      set({ error: "ファイル名を入力してください" });
      return false;
    }
    // update().select().maybeSingle() so we can detect RLS-silent failures
    // — same defensive pattern as setConfirmation().
    const { data, error } = await supabase
      .from("org_versions")
      .update({ name: trimmed })
      .eq("id", id)
      .select("id, name")
      .maybeSingle();
    if (error) {
      set({ error: error.message });
      return false;
    }
    if (!data) {
      set({
        error:
          "DBへの反映が確認できませんでした。Supabase の org_versions テーブルで anon ロールに対する UPDATE が許可されているか（行レベルセキュリティ）をご確認ください。",
      });
      return false;
    }
    set({
      versions: get().versions.map((v) =>
        v.id === id ? { ...v, name: trimmed } : v,
      ),
    });
    useVersionsRealtime.getState().broadcastChange({
      kind: "renamed",
      versionId: id,
      name: trimmed,
    });
    return true;
  },

  updatePermissions: async (id, patch) => {
    if (!supabase) return false;
    const { error } = await supabase
      .from("org_versions")
      .update(patch)
      .eq("id", id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({
      versions: get().versions.map((v) =>
        v.id === id ? { ...v, ...patch } : v,
      ),
    });
    return true;
  },

  setConfirmation: async (id, patch) => {
    if (!supabase) return false;
    // Use update().select().maybeSingle() so PostgREST returns the row that
    // was actually written. If RLS silently blocks the UPDATE the response
    // has no error but `data` is null — the previous code treated that as
    // success and wrote optimistically to local state, so the toggle looked
    // like it persisted but reverted on reload. Treating null as failure
    // surfaces the real cause to the user.
    const { data, error } = await supabase
      .from("org_versions")
      .update(patch)
      .eq("id", id)
      .select("id, is_confirmed, confirmed_period")
      .maybeSingle();
    if (error) {
      set({ error: error.message });
      return false;
    }
    if (!data) {
      set({
        error:
          "DBへの反映が確認できませんでした。Supabase の org_versions テーブルで anon ロールに対する UPDATE が許可されているか（行レベルセキュリティ）をご確認ください。",
      });
      return false;
    }
    const row = data as { is_confirmed?: boolean; confirmed_period?: string | null };
    if (
      row.is_confirmed !== patch.is_confirmed ||
      (row.confirmed_period ?? null) !== (patch.confirmed_period ?? null)
    ) {
      set({
        error:
          "更新が DB に反映されませんでした（RLS の WITH CHECK 句で弾かれている可能性があります）。",
      });
      return false;
    }
    set({
      versions: get().versions.map((v) =>
        v.id === id ? { ...v, ...patch } : v,
      ),
    });
    useVersionsRealtime.getState().broadcastChange({
      kind: "confirmed",
      versionId: id,
    });
    return true;
  },

  getSnapshot: async (id) => {
    if (!supabase) return null;
    let resp = await supabase
      .from("org_versions")
      .select("snapshot, rev")
      .eq("id", id)
      .maybeSingle();
    if (resp.error && EDITING_COLS_RE.test(resp.error.message)) {
      // 0027 未適用: rev 抜きで再試行。
      resp = (await supabase
        .from("org_versions")
        .select("snapshot")
        .eq("id", id)
        .maybeSingle()) as typeof resp;
    }
    if (resp.error) {
      set({ error: resp.error.message });
      return null;
    }
    if (!resp.data) return null;
    const row = resp.data as { snapshot: { nodes?: OrgNode[] } | null; rev?: number };
    if (!row.snapshot || !Array.isArray(row.snapshot.nodes)) return null;
    return { nodes: row.snapshot.nodes, rev: row.rev ?? 0 };
  },

  remove: async (id) => {
    if (!supabase) return false;
    const { error } = await supabase.from("org_versions").delete().eq("id", id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({ versions: get().versions.filter((v) => v.id !== id) });
    useVersionsRealtime.getState().broadcastChange({
      kind: "deleted",
      versionId: id,
    });
    return true;
  },
}));

export { isSupabaseConfigured };
