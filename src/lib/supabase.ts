import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: false },
    })
  : null;

export type AppUserRole = "master" | "editor" | "viewer";

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
  /** Optional fields added by migration 0001. May be absent on older rows. */
  created_by_email?: string | null;
  is_private?: boolean;
  grants?: VersionGrants;
};

export type VersionWithSnapshot = VersionRow & {
  snapshot: { nodes: unknown[] };
};

/** Row shape of public.employees (migration 0002). */
export type EmployeeRow = {
  employee_number: string;
  last_name: string | null;
  first_name: string | null;
  email: string | null;
  employment_type: string | null;
  department: string | null;
  position_title: string | null;
  hired_at: string | null;
  left_at: string | null;
  updated_at: string;
};
