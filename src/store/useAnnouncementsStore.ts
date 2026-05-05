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
    // .maybeSingle() rather than .single() so a 0-row response (which can
    // happen if RLS denies SELECT-after-INSERT) returns data:null instead
    // of throwing — letting us tell the user *what* went wrong.
    const { data, error } = await supabase
      .from("hr_announcements")
      .insert(input)
      .select("*")
      .maybeSingle();
    if (error) {
      const isMissing = /relation .*hr_announcements.* does not exist/i.test(error.message);
      set({
        error: isMissing
          ? "発令テーブル(hr_announcements)が見つかりません。supabase/migrations/0005_hr_announcements.sql をSQLエディタで実行してください。"
          : `発令資料の保存に失敗しました: ${error.message}`,
      });
      return null;
    }
    if (!data) {
      set({
        error:
          "保存はされた可能性がありますが結果を取得できませんでした。Supabaseの hr_announcements テーブルで anon ロールに対する INSERT/SELECT ポリシーが両方有効か（行レベルセキュリティ）をご確認ください。",
      });
      return null;
    }
    const row = data as AnnouncementRow;
    set({ list: [row, ...get().list], error: null });
    return row;
  },

  update: async (id, patch) => {
    if (!supabase) return false;
    // Verify the UPDATE actually persisted: PostgREST returns no error when
    // RLS silently blocks an UPDATE (0 rows affected), so we have to check
    // the returned row instead of trusting "no error" as success.
    const { data, error } = await supabase
      .from("hr_announcements")
      .update(patch)
      .eq("id", id)
      .select("id, updated_at")
      .maybeSingle();
    if (error) {
      set({ error: `発令資料の更新に失敗しました: ${error.message}` });
      return false;
    }
    if (!data) {
      set({
        error:
          "DBへの反映が確認できませんでした。Supabaseの hr_announcements テーブルで anon ロールに対する UPDATE が許可されているかご確認ください。",
      });
      return false;
    }
    set({
      list: get().list.map((r) =>
        r.id === id ? { ...r, ...patch, updated_at: new Date().toISOString() } : r,
      ),
      error: null,
    });
    return true;
  },

  remove: async (id) => {
    if (!supabase) return false;
    // Same RLS-resilient pattern: confirm the row was actually deleted by
    // requesting it back. If it's still there we know DELETE was blocked.
    const { error } = await supabase
      .from("hr_announcements")
      .delete()
      .eq("id", id);
    if (error) {
      set({ error: `削除に失敗しました: ${error.message}` });
      return false;
    }
    const verify = await supabase
      .from("hr_announcements")
      .select("id")
      .eq("id", id)
      .maybeSingle();
    if (verify.data) {
      set({
        error:
          "削除がDBに反映されませんでした。Supabaseの hr_announcements テーブルで anon ロールに対する DELETE が許可されているかご確認ください。",
      });
      return false;
    }
    set({ list: get().list.filter((r) => r.id !== id), error: null });
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
      .maybeSingle();
    if (error) {
      set({ error: error.message });
      return null;
    }
    if (!data) {
      set({ error: "発令資料が見つかりません" });
      return null;
    }
    return data as AnnouncementRow;
  },
}));
