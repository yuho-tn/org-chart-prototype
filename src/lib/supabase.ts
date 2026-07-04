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

/** Roles that may open the 権限管理 page (migration 0015).
 *  master / privileged_admin のみ — payroll と同じ組。 */
export function canManagePermissions(role: AppUserRole | undefined | null): boolean {
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

/** Row shape of public.employees (migrations 0002 + 0003 + 0013).
 *  full_name combines what the CSV may carry as 姓 + 名 OR 氏名 OR
 *  the English equivalents — see useEmployeesStore for the mapping. */
export type EmployeeRow = {
  employee_number: string;
  full_name: string | null;
  /** Talent Hub上の使用ネーム（旧姓など）。NULLなら full_name を使う。
   *  シート/CSV取込では上書きされない（手動管理・migration 0014）。 */
  display_name?: string | null;
  email: string | null;
  employment_type: string | null;
  department: string | null;
  position_title: string | null;
  hired_at: string | null;
  left_at: string | null;
  updated_at: string;
  /** Salary system: which career track this person is on. NULL for those
   *  not yet assigned (HR picks management vs specialist for 正社員) or
   *  not in scope (アルバイト/インターン). Added in migration 0013. */
  career_track?: CareerTrack | null;
};

/**
 * The name to show for an employee anywhere in the app: the Talent Hub
 * 使用ネーム (display_name — e.g. 旧姓) when set, otherwise the legal
 * full_name, otherwise the employee number as a last resort.
 */
export function employeeName(
  e: Pick<EmployeeRow, "employee_number" | "full_name" | "display_name">,
): string {
  return (
    e.display_name?.trim() ||
    e.full_name?.trim() ||
    e.employee_number
  );
}

// ── Payroll / salary system types (migration 0013) ───────────────────

export type CareerTrack = "management" | "specialist" | "diverse";
export type GradeTier = "officer" | "manager" | "non_manager";
export type PeriodCode =
  | "1H1" | "1H2" | "2H1" | "2H2" | "3H1" | "3H2" | "4H1" | "4H2" | "5H1";
export type EvaluationGrade = "S" | "A+" | "A" | "B+" | "B" | "B-" | "C" | "D";

export type GradeRow = {
  code: string;
  /** Null for non_manager grades shared across management & specialist. */
  career_track: CareerTrack | null;
  tier: GradeTier;
  label: string;
  expectation: string | null;
  min_monthly_salary: number | null;  // 円単位
  bonus_months: number | null;
  annual_cap: number | null;
  title_by_function: Record<string, string>;
  sort_order: number;
  is_active: boolean;
  updated_at: string;
};

export type PeriodRow = {
  code: PeriodCode;
  label: string;
  start_date: string;       // YYYY-MM-DD
  end_date: string;
  monthly_salary_budget: number | null;
  is_closed: boolean;
  sort_order: number;
};

export type SalaryRecordRow = {
  id: string;
  employee_number: string;
  period: PeriodCode;
  grade_code: string | null;
  career_track: CareerTrack | null;
  evaluation_grade: EvaluationGrade | null;
  base_salary: number | null;             // 円単位
  fixed_overtime_allowance: number | null; // 円単位
  total_monthly_salary: number;           // generated
  comment: string | null;
  updated_at: string;
  updated_by_email: string | null;
};

export type SalaryAuditLogRow = {
  id: number;
  table_name: string;
  row_id: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  before_value: Record<string, unknown> | null;
  after_value: Record<string, unknown> | null;
  actor_email: string | null;
  changed_at: string;
};
