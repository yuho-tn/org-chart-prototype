import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

// Auth opts: persist the OAuth session so reloads stay signed in, and
// have the client parse the redirect URL after Google bounces the user
// back from /auth/v1/callback.
export const supabase = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export type AppUserRole =
  | "master"
  | "privileged_admin"
  | "admin"
  | "editor"
  | "viewer";

/** Roles that may access the Payroll system (給与・査定).
 *  Mirrors the SECURITY DEFINER function `public.is_payroll_manager` —
 *  keep them in sync. */
export function canAccessPayroll(role: AppUserRole | undefined | null): boolean {
  return role === "master" || role === "privileged_admin";
}

export type AppUserRow = {
  email: string;
  display_name: string | null;
  role: AppUserRole;
  created_at: string;
};

export type VersionGrants = Record<string, "view" | "edit">;

export type VersionRow = {
  id: string;
  name: string;
  author: string;
  note: string | null;
  created_at: string;
  /** Migration 0006: set whenever the row's snapshot is overwritten. */
  updated_at?: string;
  /** Optional fields added by migration 0001. May be absent on older rows. */
  created_by_email?: string | null;
  is_private?: boolean;
  grants?: VersionGrants;
  /** Migration 0004: set when this version has been "FIX登録"-ed. */
  is_confirmed?: boolean;
  /** YYYY-MM string identifying the month a confirmed version represents. */
  confirmed_period?: string | null;
};

export type VersionWithSnapshot = VersionRow & {
  snapshot: { nodes: unknown[] };
};

/** Row shape of public.employees (migrations 0002 + 0003).
 *  full_name combines what the CSV may carry as 姓 + 名 OR 氏名 OR
 *  the English equivalents — see useEmployeesStore for the mapping. */
export type EmployeeRow = {
  employee_number: string;
  full_name: string | null;
  email: string | null;
  employment_type: string | null;
  department: string | null;
  position_title: string | null;
  hired_at: string | null;
  left_at: string | null;
  updated_at: string;
};
