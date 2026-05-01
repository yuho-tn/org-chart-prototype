import { create } from "zustand";
import { supabase } from "../lib/supabase";
import type { AnnouncementPayload } from "../lib/announcement";

export type AnnouncementRow = {
  id: string;
  period: string;
  title: string;
  version_a_id: string | null;
  version_b_id: string | null;
  payload: AnnouncementPayload;
  created_by_email: string | null;
  is_published: boolean;
  created_at: string;
  updated_at: string;
};

type AnnouncementsState = {
  list: AnnouncementRow[];
  loading: boolean;
  error: string | null;

  refresh: () => Promise<void>;
  /** Create a new announcement and return the saved row. */
  create: (input: {
    period: string;
    title: string;
    version_a_id: string | null;
    version_b_id: string | null;
    payload: AnnouncementPayload;
    created_by_email: string | null;
  }) => Promise<AnnouncementRow | null>;
  /** Patch an existing announcement (title / payload / published flag). */
  update: (
    id: string,
    patch: Partial<
      Pick<AnnouncementRow, "title" | "payload" | "is_published" | "period">
    >,
  ) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
  /** Fetch a single announcement by id (used by the detail page so anyone with
   *  the share URL can land on it without first listing). */
  getById: (id: string) => Promise<AnnouncementRow | null>;
};

export const useAnnouncementsStore = create<AnnouncementsState>((set, get) => ({
  list: [],
  loading: false,
  error: null,

  refresh: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("hr_announcements")
      .select("*")
      .order("period", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) {
      const isMissing = /relation .*hr_announcements.* does not exist/i.test(error.message);
      set({
        loading: false,
        error: isMissing
          ? "発令テーブルが見つかりません。supabase/migrations/0005_hr_announcements.sql をSQLエディタで実行してください。"
          : error.message,
        list: [],
      });
      return;
    }
    set({ loading: false, list: (data ?? []) as AnnouncementRow[], error: null });
  },

  create: async (input) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from("hr_announcements")
      .insert(input)
      .select("*")
      .single();
    if (error || !data) {
      set({ error: error?.message ?? "保存に失敗しました" });
      return null;
    }
    const row = data as AnnouncementRow;
    set({ list: [row, ...get().list] });
    return row;
  },

  update: async (id, patch) => {
    if (!supabase) return false;
    const { error } = await supabase
      .from("hr_announcements")
      .update(patch)
      .eq("id", id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({
      list: get().list.map((r) =>
        r.id === id ? { ...r, ...patch, updated_at: new Date().toISOString() } : r,
      ),
    });
    return true;
  },

  remove: async (id) => {
    if (!supabase) return false;
    const { error } = await supabase
      .from("hr_announcements")
      .delete()
      .eq("id", id);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({ list: get().list.filter((r) => r.id !== id) });
    return true;
  },

  getById: async (id) => {
    if (!supabase) return null;
    // First check the in-memory list.
    const cached = get().list.find((r) => r.id === id);
    if (cached) return cached;
    const { data, error } = await supabase
      .from("hr_announcements")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) {
      set({ error: error?.message ?? "発令の取得に失敗しました" });
      return null;
    }
    return data as AnnouncementRow;
  },
}));
