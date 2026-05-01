import { create } from "zustand";
import {
  supabase,
  isSupabaseConfigured,
  type VersionRow,
  type VersionGrants,
} from "../lib/supabase";
import type { OrgNode } from "../lib/types";

const VERSION_SELECT =
  "id, name, author, note, created_at, created_by_email, is_private, grants, is_confirmed, confirmed_period";

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

    let resp = (await supabase
      .from("org_versions")
      .insert(payload)
      .select(VERSION_SELECT)
      .single()) as { data: unknown; error: { message: string } | null };
    if (
      resp.error &&
      /column .*(created_by_email|is_private|grants).* does not exist/i.test(resp.error.message)
    ) {
      // Legacy schema fallback: drop the permission fields and try again.
      resp = (await supabase
        .from("org_versions")
        .insert({ name, author, note, snapshot: { nodes } })
        .select("id, name, author, note, created_at")
        .single()) as { data: unknown; error: { message: string } | null };
    }
    if (resp.error || !resp.data) {
      set({ error: resp.error?.message ?? "保存に失敗しました" });
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
      .single();
    if (error || !data) {
      set({ error: error?.message ?? "読み込みに失敗しました" });
      return null;
    }
    const snap = data.snapshot as { nodes?: OrgNode[] } | null;
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
