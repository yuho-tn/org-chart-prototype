import { create } from "zustand";
import {
  supabase,
  isSupabaseConfigured,
  type VersionRow,
  type VersionGrants,
} from "../lib/supabase";
import type { OrgNode } from "../lib/types";

const VERSION_SELECT =
  "id, name, author, note, created_at, updated_at, created_by_email, is_private, grants, is_confirmed, confirmed_period";

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
  /** Overwrite an existing file's nodes (the file-model "保存"). The row's
   *  metadata is preserved; only the snapshot + updated_at change. Returns
   *  the refreshed VersionRow on success. */
  updateSnapshot: (
    id: string,
    nodes: OrgNode[],
    optionalPatch?: Partial<Pick<VersionRow, "name" | "note">>,
  ) => Promise<VersionRow | null>;
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
  /** Promote a draft version to a confirmed monthly snapshot, OR demote it
   *  back to a draft (period=null, is_confirmed=false). */
  setConfirmation: (
    id: string,
    patch: { is_confirmed: boolean; confirmed_period: string | null },
  ) => Promise<boolean>;
  /** Returns the snapshot.nodes for a given version id, or null on error. */
  getSnapshot: (id: string) => Promise<OrgNode[] | null>;
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
    let resp = (await supabase
      .from("org_versions")
      .select(VERSION_SELECT)
      .order("created_at", { ascending: false })
      .limit(100)) as { data: unknown; error: { message: string } | null };
    // The new permission columns may not exist yet (migration not run);
    // fall back to the legacy column set so the app still works.
    if (
      resp.error &&
      /column .*(created_by_email|is_private|grants).* does not exist/i.test(resp.error.message)
    ) {
      resp = (await supabase
        .from("org_versions")
        .select("id, name, author, note, created_at")
        .order("created_at", { ascending: false })
        .limit(100)) as { data: unknown; error: { message: string } | null };
    }
    if (resp.error) {
      set({ loading: false, error: resp.error.message });
      return;
    }
    set({ loading: false, versions: ((resp.data ?? []) as VersionRow[]) });
  },

  save: async ({ name, author, note, nodes, created_by_email, is_private, grants }) => {
    if (!supabase) {
      set({ error: "Supabaseが設定されていません" });
      return null;
    }
    const payload: Record<string, unknown> = {
      name,
      author,
      note,
      snapshot: { nodes },
    };
    if (created_by_email !== undefined) payload.created_by_email = created_by_email;
    if (is_private !== undefined) payload.is_private = is_private;
    if (grants !== undefined) payload.grants = grants;

    // .maybeSingle() is critical here: when an RLS policy on the table denies
    // the SELECT-after-INSERT (a common misconfiguration) PostgREST returns
    // 0 rows. .single() throws "Cannot coerce the result to a single JSON
    // object"; .maybeSingle() returns data: null and lets us recover.
    let resp = (await supabase
      .from("org_versions")
      .insert(payload)
      .select(VERSION_SELECT)
      .maybeSingle()) as { data: unknown; error: { message: string } | null };
    if (
      resp.error &&
      /column .*(created_by_email|is_private|grants).* does not exist/i.test(resp.error.message)
    ) {
      resp = (await supabase
        .from("org_versions")
        .insert({ name, author, note, snapshot: { nodes } })
        .select("id, name, author, note, created_at")
        .maybeSingle()) as { data: unknown; error: { message: string } | null };
    }
    if (resp.error) {
      set({ error: resp.error.message });
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
    return row;
  },

  updateSnapshot: async (id, nodes, optionalPatch) => {
    if (!supabase) return null;
    const patch: Record<string, unknown> = { snapshot: { nodes } };
    if (optionalPatch?.name !== undefined) patch.name = optionalPatch.name;
    if (optionalPatch?.note !== undefined) patch.note = optionalPatch.note;

    const { data, error } = await supabase
      .from("org_versions")
      .update(patch)
      .eq("id", id)
      .select(VERSION_SELECT)
      .maybeSingle();
    if (error) {
      set({ error: error.message });
      return null;
    }
    // RLS may withhold the returned row even when the update succeeded.
    // In that case fall back to a separate select; if THAT also returns
    // nothing, apply an optimistic patch locally so the UI stays in sync.
    let row: VersionRow | null = (data as VersionRow | null) ?? null;
    if (!row) {
      const refetch = await supabase
        .from("org_versions")
        .select(VERSION_SELECT)
        .eq("id", id)
        .maybeSingle();
      row = (refetch.data as VersionRow | null) ?? null;
    }
    if (!row) {
      const existing = get().versions.find((v) => v.id === id);
      if (!existing) return null;
      const optimistic: VersionRow = {
        ...existing,
        ...(optionalPatch?.name !== undefined ? { name: optionalPatch.name } : {}),
        ...(optionalPatch?.note !== undefined ? { note: optionalPatch.note } : {}),
        updated_at: new Date().toISOString(),
      };
      set({
        versions: get().versions.map((v) => (v.id === id ? optimistic : v)),
      });
      return optimistic;
    }
    set({
      versions: get().versions.map((v) => (v.id === id ? row! : v)),
    });
    return row;
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
    const insertPayload: Record<string, unknown> = {
      name: nameOverride,
      author,
      note: (src as { note: string | null }).note,
      snapshot: (src as { snapshot: unknown }).snapshot,
      created_by_email,
      is_confirmed: false,
      confirmed_period: null,
      is_private: false,
      grants: {},
    };
    let resp = (await supabase
      .from("org_versions")
      .insert(insertPayload)
      .select(VERSION_SELECT)
      .maybeSingle()) as { data: unknown; error: { message: string } | null };
    if (
      resp.error &&
      /column .*(created_by_email|is_private|grants|is_confirmed|confirmed_period).* does not exist/i.test(
        resp.error.message,
      )
    ) {
      resp = (await supabase
        .from("org_versions")
        .insert({
          name: nameOverride,
          author,
          note: (src as { note: string | null }).note,
          snapshot: (src as { snapshot: unknown }).snapshot,
        })
        .select("id, name, author, note, created_at")
        .maybeSingle()) as { data: unknown; error: { message: string } | null };
    }
    if (resp.error) {
      set({ error: resp.error.message });
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

  getSnapshot: async (id) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("org_versions")
      .select("snapshot")
      .eq("id", id)
      .maybeSingle();
    if (error) {
      set({ error: error.message });
      return null;
    }
    if (!data) return null;
    const snap = (data as { snapshot: { nodes?: OrgNode[] } | null }).snapshot;
    if (!snap || !Array.isArray(snap.nodes)) return null;
    return snap.nodes;
  },

  remove: async (id) => {
    if (!supabase) return false;
    const { error } = await supabase.from("org_versions").delete().eq("id", id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({ versions: get().versions.filter((v) => v.id !== id) });
    return true;
  },
}));

export { isSupabaseConfigured };
