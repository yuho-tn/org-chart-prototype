import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { AppUserRow, AppUserRole } from "../lib/supabase";

const CURRENT_EMAIL_KEY = "org-chart-prototype:current-email";

function readStoredEmail(): string | null {
  try {
    return localStorage.getItem(CURRENT_EMAIL_KEY);
  } catch {
    return null;
  }
}

function writeStoredEmail(email: string | null) {
  try {
    if (email) localStorage.setItem(CURRENT_EMAIL_KEY, email);
    else localStorage.removeItem(CURRENT_EMAIL_KEY);
  } catch {
    // ignore quota errors
  }
}

type AuthState = {
  /** Email used to identify the current user (carried in localStorage). */
  currentEmail: string | null;
  /** The matching app_users row, if found. */
  currentUser: AppUserRow | null;
  /** All registered users. Loaded once on bootstrap; refreshed by user-mgmt UI. */
  users: AppUserRow[];
  /** True after the first refresh() resolves so callers know the bootstrap state is reliable. */
  initialized: boolean;
  loading: boolean;
  error: string | null;

  /** Set the in-memory email (also persists). Does NOT validate against the server. */
  setCurrentEmail: (email: string | null) => void;
  /** Fetch users + resolve currentUser from currentEmail. */
  refresh: () => Promise<void>;
  /** Insert a new user. Returns ok=false with reason on duplicate / missing field. */
  addUser: (input: {
    email: string;
    display_name: string;
    role: AppUserRole;
  }) => Promise<{ ok: boolean; reason?: string }>;
  removeUser: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  setUserRole: (email: string, role: AppUserRole) => Promise<boolean>;
  /** Sign out: clear localStorage email and currentUser. */
  signOut: () => void;
};

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  currentEmail: readStoredEmail(),
  currentUser: null,
  users: [],
  initialized: false,
  loading: false,
  error: null,

  setCurrentEmail: (email) => {
    const norm = email ? normalizeEmail(email) : null;
    writeStoredEmail(norm);
    const found = norm ? get().users.find((u) => u.email === norm) ?? null : null;
    set({ currentEmail: norm, currentUser: found });
  },

  refresh: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ initialized: true });
      return;
    }
    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("app_users")
      .select("email, display_name, role, created_at")
      .order("created_at", { ascending: true });
    if (error) {
      // The most common cause of failure is "table does not exist" — the
      // migration hasn't been run yet. Surface that clearly so the user
      // knows what to do.
      const isMissingTable =
        /relation .*app_users.* does not exist/i.test(error.message) ||
        /could not find the table/i.test(error.message);
      set({
        loading: false,
        initialized: true,
        users: [],
        error: isMissingTable
          ? "ユーザーテーブルが見つかりません。supabase/migrations/0001_users_and_permissions.sql をSupabaseのSQLエディタで実行してください。"
          : `ユーザー一覧の取得に失敗しました: ${error.message}`,
      });
      return;
    }
    const users = (data ?? []) as AppUserRow[];
    const email = get().currentEmail;
    const currentUser = email ? users.find((u) => u.email === email) ?? null : null;
    set({ loading: false, initialized: true, users, currentUser, error: null });
  },

  addUser: async ({ email, display_name, role }) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const norm = normalizeEmail(email);
    if (!norm.includes("@")) return { ok: false, reason: "メールアドレスの形式が不正です" };
    const existing = get().users.find((u) => u.email === norm);
    if (existing) return { ok: false, reason: "そのメールアドレスは既に登録済みです" };
    const { data, error } = await supabase
      .from("app_users")
      .insert({ email: norm, display_name: display_name.trim() || null, role })
      .select("email, display_name, role, created_at")
      .single();
    if (error || !data) {
      return { ok: false, reason: error?.message ?? "登録に失敗しました" };
    }
    const row = data as AppUserRow;
    const next = [...get().users, row].sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const email2 = get().currentEmail;
    set({
      users: next,
      currentUser: email2 === row.email ? row : get().currentUser,
    });
    return { ok: true };
  },

  removeUser: async (email) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const norm = normalizeEmail(email);
    if (norm === get().currentEmail) {
      return { ok: false, reason: "現在ログイン中のユーザーは削除できません" };
    }
    const { error } = await supabase.from("app_users").delete().eq("email", norm);
    if (error) return { ok: false, reason: error.message };
    set({ users: get().users.filter((u) => u.email !== norm) });
    return { ok: true };
  },

  setUserRole: async (email, role) => {
    if (!supabase) return false;
    const norm = normalizeEmail(email);
    const { error } = await supabase
      .from("app_users")
      .update({ role })
      .eq("email", norm);
    if (error) {
      set({ error: error.message });
      return false;
    }
    const next = get().users.map((u) => (u.email === norm ? { ...u, role } : u));
    set({
      users: next,
      currentUser:
        get().currentEmail === norm
          ? next.find((u) => u.email === norm) ?? get().currentUser
          : get().currentUser,
    });
    return true;
  },

  signOut: () => {
    writeStoredEmail(null);
    set({ currentEmail: null, currentUser: null });
  },
}));

/**
 * Permission helper — given the current user and a version row, decide
 * whether the user can view and/or edit it. Returns null on "no access".
 *
 * Rules (per spec):
 *   • master: sees everything, can edit everything (including private).
 *   • editor: sees non-private versions + their own + ones explicitly granted.
 *             Edits ones they created or were granted "edit".
 *   • viewer: same visibility as editor but cannot edit anything.
 *   • Private versions are visible only to creator, master, or explicit grantees.
 */
export type VersionAccess = { view: true; edit: boolean };

export function accessForVersion(
  user: AppUserRow | null,
  v: {
    created_by_email?: string | null;
    is_private?: boolean;
    grants?: Record<string, "view" | "edit">;
  },
): VersionAccess | null {
  if (!user) return null;
  const isCreator = !!v.created_by_email && v.created_by_email === user.email;
  const grant = v.grants?.[user.email];

  if (user.role === "master") {
    return { view: true, edit: true };
  }

  if (v.is_private && !isCreator && !grant) return null;

  // Non-master users see all non-private versions plus their own/granted ones.
  const canEdit =
    user.role === "editor" && (isCreator || grant === "edit");

  return { view: true, edit: canEdit };
}
