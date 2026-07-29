import { create } from "zustand";
import { supabase } from "../lib/supabase";

/**
 * 人件費管理（#/labor）のアクセス権限マスター管理。
 *
 * laborcost_admins テーブルを owner/viewer の2ロールで管理する。
 *  - owner  … データ閲覧 ＋ このリストの追加/削除ができる
 *  - viewer … データ閲覧のみ（このストア＝管理UIは owner にだけ露出）
 *
 * 書き込みは RLS（is_laborcost_owner）でも二重にゲートされる。owner を
 * 0人にする操作は DB トリガで必ず失敗する（ロックアウト防止）。
 */

export type LaborRole = "owner" | "viewer";

export type LaborAdminRow = {
  email: string;
  role: LaborRole;
  created_at: string;
};

type State = {
  isOwner: boolean;
  ownerChecked: boolean;
  admins: LaborAdminRow[];
  loading: boolean;
  error: string | null;
  busy: boolean; // 追加/削除/変更の実行中

  checkOwner: () => Promise<void>;
  loadAdmins: () => Promise<void>;
  /** email を追加（既存なら role を上書き）。成功で true。 */
  addAdmin: (email: string, role: LaborRole) => Promise<{ ok: boolean; reason?: string }>;
  removeAdmin: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  updateRole: (email: string, role: LaborRole) => Promise<{ ok: boolean; reason?: string }>;
};

const norm = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** DB のエラーメッセージ（トリガの日本語 raise 等）を UI 用に取り出す。 */
function reasonOf(error: { message?: string } | null | undefined, fallback: string): string {
  const m = error?.message ?? "";
  // 最後の owner ガード（トリガ）の日本語メッセージをそのまま見せる。
  if (m.includes("管理者(owner)")) return "管理者(owner)を0人にはできません。先に別の管理者を追加してください。";
  return m || fallback;
}

export const useLaborAccessStore = create<State>((set, get) => ({
  isOwner: false,
  ownerChecked: false,
  admins: [],
  loading: false,
  error: null,
  busy: false,

  checkOwner: async () => {
    if (!supabase) { set({ ownerChecked: true, isOwner: false }); return; }
    const { data, error } = await supabase.rpc("laborcost_is_owner");
    set({ ownerChecked: true, isOwner: !error && data === true });
  },

  loadAdmins: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("laborcost_admins")
      .select("email, role, created_at")
      .order("role")
      .order("created_at");
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    set({ loading: false, admins: (data ?? []) as LaborAdminRow[] });
  },

  addAdmin: async (emailRaw, role) => {
    if (!supabase) return { ok: false, reason: "未接続" };
    const email = norm(emailRaw);
    if (!EMAIL_RE.test(email)) return { ok: false, reason: "メールアドレスの形式が正しくありません。" };
    if (get().admins.some((a) => a.email === email)) {
      return { ok: false, reason: "すでに登録済みのアドレスです。" };
    }
    set({ busy: true });
    const { error } = await supabase.from("laborcost_admins").upsert({ email, role }, { onConflict: "email" });
    set({ busy: false });
    if (error) return { ok: false, reason: reasonOf(error, "追加に失敗しました。") };
    await get().loadAdmins();
    return { ok: true };
  },

  removeAdmin: async (emailRaw) => {
    if (!supabase) return { ok: false, reason: "未接続" };
    const email = norm(emailRaw);
    set({ busy: true });
    const { error } = await supabase.from("laborcost_admins").delete().eq("email", email);
    set({ busy: false });
    if (error) return { ok: false, reason: reasonOf(error, "削除に失敗しました。") };
    await get().loadAdmins();
    return { ok: true };
  },

  updateRole: async (emailRaw, role) => {
    if (!supabase) return { ok: false, reason: "未接続" };
    const email = norm(emailRaw);
    set({ busy: true });
    const { error } = await supabase.from("laborcost_admins").update({ role }).eq("email", email);
    set({ busy: false });
    if (error) return { ok: false, reason: reasonOf(error, "変更に失敗しました。") };
    await get().loadAdmins();
    return { ok: true };
  },
}));
