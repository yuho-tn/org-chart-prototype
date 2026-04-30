import { create } from "zustand";
import { supabase, isSupabaseConfigured, type VersionRow } from "../lib/supabase";
import type { OrgNode } from "../lib/types";

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
  }) => Promise<VersionRow | null>;
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
    const { data, error } = await supabase
      .from("org_versions")
      .select("id, name, author, note, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    set({ loading: false, versions: (data ?? []) as VersionRow[] });
  },

  save: async ({ name, author, note, nodes }) => {
    if (!supabase) {
      set({ error: "Supabaseが設定されていません" });
      return null;
    }
    const { data, error } = await supabase
      .from("org_versions")
      .insert({ name, author, note, snapshot: { nodes } })
      .select("id, name, author, note, created_at")
      .single();
    if (error) {
      set({ error: error.message });
      return null;
    }
    const row = data as VersionRow;
    set({ versions: [row, ...get().versions] });
    return row;
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
