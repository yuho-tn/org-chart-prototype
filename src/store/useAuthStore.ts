import { create } from "zustand";
import type { Session } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { AppUserRow, AppUserRole } from "../lib/supabase";

/**
 * Auth model (post-0008):
 *   • Identity is a real Supabase Auth session, populated by Google OAuth
 *     with hd=sho-san.co.jp domain restriction.
 *   • Authorization data lives in public.app_users — every authenticated
 *     user has a matching row (auto-provisioned by the on_auth_user_created
 *     trigger) carrying their role: master / admin / editor / viewer.
 *   • Viewer-mode share links (?versionId=xxx) bypass auth entirely; the
 *     app sets viewOnly=true and never invokes this store.
 */

type AuthState = {
  /** Live Supabase session, refreshed by onAuthStateChange. */
  session: Session | null;
  /** The matching app_users row resolved from session.user.email. */
  currentUser: AppUserRow | null;
  /** All registered users. Only master/admin can mutate (RLS enforces). */
  users: AppUserRow[];
  /** True once the initial getSession() has resolved. */
  initialized: boolean;
  loading: boolean;
  error: string | null;

  /** Kick off Google OAuth (with hd=sho-san.co.jp). Returns immediately —
   *  the browser navigates to Google and back to redirectTo. */
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read app_users + resolve currentUser from the live session.
   *  Called on bootstrap and after the auth state changes. */
  refresh: () => Promise<void>;
  /** Wire onAuthStateChange — call once on app boot. */
  initialize: () => Promise<void>;

  addUser: (input: {
    email: string;
    display_name: string;
    role: AppUserRole;
  }) => Promise<{ ok: boolean; reason?: string }>;
  removeUser: (email: string) => Promise<{ ok: boolean; reason?: string }>;
  setUserRole: (email: string, role: AppUserRole) => Promise<boolean>;
};

function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}

function siteOrigin(): string {
  if (typeof window === "undefined") return "";
  return window.location.origin;
}

let authSubscription: { unsubscribe: () => void } | null = null;

export const useAuthStore = create<AuthState>((set, get) => ({
  session: null,
  currentUser: null,
  users: [],
  initialized: false,
  loading: false,
  error: null,

  initialize: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ initialized: true });
      return;
    }
    const { data } = await supabase.auth.getSession();
    set({ session: data.session ?? null });
    await get().refresh();
    if (!authSubscription) {
      const sub = supabase.auth.onAuthStateChange(async (_event, session) => {
        set({ session: session ?? null });
        await get().refresh();
      });
      authSubscription = sub.data.subscription;
    }
  },

  signInWithGoogle: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: siteOrigin(),
        // Restrict the Google account picker to sho-san.co.jp Workspace
        // accounts. The on_auth_user_created trigger enforces the same
        // rule server-side so out-of-domain accounts can't sneak through.
        queryParams: { hd: "sho-san.co.jp" },
      },
    });
    if (error) {
      set({ loading: false, error: error.message });
      return;
    }
    // Browser is now navigating away to Google; loading stays true until
    // we land back via detectSessionInUrl.
  },

  signOut: async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    set({ session: null, currentUser: null });
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
    const sessionEmail = get().session?.user?.email
      ? normalizeEmail(get().session!.user!.email!)
      : null;
    const currentUser = sessionEmail
      ? users.find((u) => u.email === sessionEmail) ?? null
      : null;
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
    set({ users: next });
    return { ok: true };
  },

  removeUser: async (email) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const norm = normalizeEmail(email);
    const selfEmail = get().session?.user?.email
      ? normalizeEmail(get().session!.user!.email!)
      : null;
    if (norm === selfEmail) {
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
    const sessionEmail = get().session?.user?.email
      ? normalizeEmail(get().session!.user!.email!)
      : null;
    set({
      users: next,
      currentUser:
        sessionEmail === norm
          ? next.find((u) => u.email === norm) ?? get().currentUser
          : get().currentUser,
    });
    return true;
  },
}));

/**
 * Permission helper — given the current user and a version row, decide
 * whether the user can view and/or edit it. Returns null on "no access".
 *
 * Rules (5-tier, post-0011):
 *   • master: full access (all versions, including private).
 *   • privileged_admin: full editing access (parity with admin for org
 *      chart files) + payroll system access. Cannot manage user roles.
 *   • admin: full access for non-master operations, can edit any version.
 *   • editor: edits own creations + grants; sees public + own + granted.
 *   • viewer: sees public + own + granted; never edits.
 */
export type VersionAccess = { view: true; edit: boolean };

// ── Role-based capability helpers ───────────────────────────────────
// Use these instead of `role === "master"` checks at call sites — they
// centralize the matrix and stay in sync with the SQL helpers in 0011.

/**
 * Can mutate other users' roles. Master and admin only — privileged_admin
 * is deliberately excluded so the "give yourself payroll access" attack
 * isn't possible.
 */
export function isUserManager(role: AppUserRole | undefined | null): boolean {
  return role === "master" || role === "admin";
}

/**
 * Full org-chart editor — can edit any file (private or not), delete,
 * rename, toggle lock, confirm. Matches the SQL `is_writer()` minus
 * editor (which is restricted to own/granted via accessForVersion).
 */
export function isOrgPowerUser(role: AppUserRole | undefined | null): boolean {
  return role === "master" || role === "privileged_admin" || role === "admin";
}

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

  // master / privileged_admin / admin all get full edit access to every
  // org chart file (even private ones). Kept aligned with the SECURITY
  // DEFINER `public.is_writer()` SQL helper used by RLS — see migration
  // 0011_privileged_admin_role.sql.
  if (
    user.role === "master" ||
    user.role === "privileged_admin" ||
    user.role === "admin"
  ) {
    return { view: true, edit: true };
  }

  if (v.is_private && !isCreator && !grant) return null;

  const canEdit = user.role === "editor" && (isCreator || grant === "edit");
  return { view: true, edit: canEdit };
}
