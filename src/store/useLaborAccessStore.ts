import { create } from "zustand";
import { supabase } from "../lib/supabase";
import { fetchWithRetry } from "../lib/query";

/**
 * 人件費管理（#/labor）のアクセス権限マスター管理。
 *
 * laborcost_admins テーブルを owner/viewer の2ロールで管理する。
 *  - owner  … データ閲覧 ＋ このリストの追加/削除ができる
 *  - viewer … データ閲覧のみ（このストア＝管理UIは owner にだけ露出）
 *
 * 書き込みは RLS（is_laborcost_owner）でも二重にゲートされる。owner を
 * 0人にする操作は DB トリガで必ず失敗する（ロックアウト防止）。
 *
 * labor_div_access（0048）は、全従業員データを見せず「担当DIVの詳細人件費」
 * だけをメールアドレス単位で見せる DIV別ページ（#/labor/div/:target）の許可リスト。
 * 書き込みは owner のみ（laborcost_admins と同じ RLS パターン）。実際の閲覧可否判定は
 * ここではなく api/labor-div-report.ts（service_role・per-user JWT検証）で行う。
 */

export type LaborRole = "owner" | "viewer";

export type LaborAdminRow = {
  email: string;
  role: LaborRole;
  created_at: string;
};

/** DIV別ページ（#/labor/div/:target）の対象8種（api/_lib/laborDivReport.ts と一致）。 */
export const LABOR_DIV_TARGETS = [
  "SNS DIV", "マーケティングDIV", "制作DIV", "AI DIV",
  "フロントDIV", "HR TM", "コーポレートTM", "開発TM",
] as const;
export type LaborDivTarget = (typeof LABOR_DIV_TARGETS)[number];

export type LaborDivAccessRow = {
  email: string;
  target: LaborDivTarget;
  created_at: string;
};

type State = {
  isOwner: boolean;
  ownerChecked: boolean;
  admins: LaborAdminRow[];
  loading: boolean;
  error: string | null;
  busy: boolean; // 追加/削除/変更の実行中

  divAccess: LaborDivAccessRow[];
  divAccessLoading: boolean;
  divAccessError: string | null;

  checkOwner: () => Promise<void>;
  loadAdmins: () => Promise<void>;
  /** email を追加（既存なら role を上書き）。成功で true。 */
  addAdmin: (email: string, role: LaborRole) => Promise<{ ok: boolean; reason?: string }>;
  removeAdmin: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  updateRole: (email: string, role: LaborRole) => Promise<{ ok: boolean; reason?: string }>;

  loadDivAccess: () => Promise<void>;
  addDivAccess: (email: string, target: LaborDivTarget) => Promise<{ ok: boolean; reason?: string }>;
  removeDivAccess: (email: string, target: LaborDivTarget) => Promise<{ ok: boolean; reason?: string }>;
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

  divAccess: [],
  divAccessLoading: false,
  divAccessError: null,

  checkOwner: async () => {
    if (!supabase) { set({ ownerChecked: true, isOwner: false }); return; }
    try {
      const { data, error } = await fetchWithRetry(() => supabase!.rpc("laborcost_is_owner"));
      set({ ownerChecked: true, isOwner: !error && data === true });
    } catch {
      set({ ownerChecked: true, isOwner: false });
    }
  },

  loadAdmins: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    let result;
    try {
      result = await fetchWithRetry(() =>
        supabase!
          .from("laborcost_admins")
          .select("email, role, created_at")
          .order("role")
          .order("created_at"),
      );
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
    const { data, error } = result;
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

  loadDivAccess: async () => {
    if (!supabase) return;
    set({ divAccessLoading: true, divAccessError: null });
    let result;
    try {
      result = await fetchWithRetry(() =>
        supabase!
          .from("labor_div_access")
          .select("email, target, created_at")
          .order("target")
          .order("email"),
      );
    } catch (e) {
      set({
        divAccessLoading: false,
        divAccessError: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    const { data, error } = result;
    if (error) {
      set({ divAccessLoading: false, divAccessError: error.message });
      return;
    }
    set({ divAccessLoading: false, divAccess: (data ?? []) as LaborDivAccessRow[] });
  },

  addDivAccess: async (emailRaw, target) => {
    if (!supabase) return { ok: false, reason: "未接続" };
    const email = norm(emailRaw);
    if (!EMAIL_RE.test(email)) return { ok: false, reason: "メールアドレスの形式が正しくありません。" };
    if (get().divAccess.some((a) => a.email === email && a.target === target)) {
      return { ok: false, reason: "すでに登録済みのアドレスです。" };
    }
    set({ busy: true });
    const { error } = await supabase
      .from("labor_div_access")
      .upsert({ email, target }, { onConflict: "email,target" });
    set({ busy: false });
    if (error) return { ok: false, reason: reasonOf(error, "追加に失敗しました。") };
    await get().loadDivAccess();
    return { ok: true };
  },

  removeDivAccess: async (emailRaw, target) => {
    if (!supabase) return { ok: false, reason: "未接続" };
    const email = norm(emailRaw);
    set({ busy: true });
    const { error } = await supabase
      .from("labor_div_access")
      .delete()
      .eq("email", email)
      .eq("target", target);
    set({ busy: false });
    if (error) return { ok: false, reason: reasonOf(error, "削除に失敗しました。") };
    await get().loadDivAccess();
    return { ok: true };
  },
}));
