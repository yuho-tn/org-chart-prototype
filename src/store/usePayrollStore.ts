import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type {
  GradeRow,
  PeriodRow,
  PeriodCode,
  SalaryRecordRow,
  SalaryAuditLogRow,
  CareerTrack,
  EvaluationGrade,
} from "../lib/supabase";

/**
 * Single store for the entire Payroll system: 等級マスター / 期マスター /
 * 給与レコード / 監査ログ. Lives orthogonally to useEmployeesStore — the
 * salary table joins them client-side by employee_number.
 *
 * Realtime: subscribes to Postgres Changes on salary_records, grades,
 * periods and applies them to local state. Self-originated changes are
 * deduped through a short echo-window (same pattern as
 * useVersionsRealtime) so the editor doesn't flicker on save.
 */

const ECHO_WINDOW_MS = 4000;
const SALARY_CHANNEL = "payroll-changes";

/** Composite key for the dedupe map (employee × period). */
function recordKey(employee_number: string, period: PeriodCode): string {
  return `${employee_number}::${period}`;
}

type RecentEdit = { at: number };

type State = {
  loaded: boolean;
  loading: boolean;
  error: string | null;

  grades: GradeRow[];
  periods: PeriodRow[];
  /** salary_records keyed by employee_number::period for O(1) lookup. */
  records: Record<string, SalaryRecordRow>;
  /** Audit log, newest first. Loaded lazily by audit log page. */
  auditLog: SalaryAuditLogRow[];
  auditLoading: boolean;
  auditError: string | null;

  /** UI: cells the local user has edited in the last few seconds,
   *  used to highlight them transiently in the table. */
  recentEdits: Record<string, RecentEdit>;

  /** Realtime channel handle and last-self-save markers. */
  channel: RealtimeChannel | null;
  lastSelfSave: Record<string, number>;  // key -> timestamp

  /** Initial load (everything except audit log). */
  refresh: () => Promise<void>;
  refreshAuditLog: (limit?: number) => Promise<void>;

  /** Upsert a single (employee, period) record. Returns the saved row. */
  upsertSalaryRecord: (input: {
    employee_number: string;
    period: PeriodCode;
    grade_code?: string | null;
    career_track?: CareerTrack | null;
    evaluation_grade?: EvaluationGrade | null;
    base_salary?: number | null;
    fixed_overtime_allowance?: number | null;
    comment?: string | null;
  }) => Promise<{ ok: boolean; reason?: string; row?: SalaryRecordRow }>;

  /** Edit a grade (privileged_admin / master only by RLS). */
  upsertGrade: (input: Partial<GradeRow> & { code: string }) => Promise<{ ok: boolean; reason?: string }>;

  /** Set the per-period monthly_salary_budget on the periods master. */
  setPeriodBudget: (code: PeriodCode, monthly_salary_budget: number | null) => Promise<{ ok: boolean; reason?: string }>;

  /** Assign a career track to an employee (master/privileged_admin). */
  setEmployeeCareerTrack: (employee_number: string, track: CareerTrack | null) => Promise<{ ok: boolean; reason?: string }>;

  /** Realtime wire-up. */
  subscribe: () => void;
  unsubscribe: () => Promise<void>;
};

export const usePayrollStore = create<State>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  grades: [],
  periods: [],
  records: {},
  auditLog: [],
  auditLoading: false,
  auditError: null,
  recentEdits: {},
  channel: null,
  lastSelfSave: {},

  refresh: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true });
      return;
    }
    set({ loading: true, error: null });
    const [gRes, pRes, rRes] = await Promise.all([
      supabase.from("grades").select("*").order("sort_order"),
      supabase.from("periods").select("*").order("sort_order"),
      supabase.from("salary_records").select("*"),
    ]);
    if (gRes.error || pRes.error || rRes.error) {
      const err = gRes.error ?? pRes.error ?? rRes.error;
      const isPermission = err && /permission denied|row-level security/i.test(err.message);
      set({
        loading: false,
        loaded: true,
        error: isPermission
          ? "給与・査定の閲覧権限がありません（特権管理者またはマスター権限が必要です）"
          : err?.message ?? "給与データの取得に失敗しました",
      });
      return;
    }
    const recordsMap: Record<string, SalaryRecordRow> = {};
    for (const r of (rRes.data ?? []) as SalaryRecordRow[]) {
      recordsMap[recordKey(r.employee_number, r.period)] = r;
    }
    set({
      loading: false,
      loaded: true,
      error: null,
      grades: (gRes.data ?? []) as GradeRow[],
      periods: (pRes.data ?? []) as PeriodRow[],
      records: recordsMap,
    });
  },

  refreshAuditLog: async (limit = 200) => {
    if (!supabase) return;
    set({ auditLoading: true, auditError: null });
    const { data, error } = await supabase
      .from("salary_audit_log")
      .select("*")
      .order("changed_at", { ascending: false })
      .limit(limit);
    if (error) {
      set({ auditLoading: false, auditError: error.message });
      return;
    }
    set({
      auditLoading: false,
      auditLog: (data ?? []) as SalaryAuditLogRow[],
      auditError: null,
    });
  },

  upsertSalaryRecord: async (input) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定" };
    const key = recordKey(input.employee_number, input.period);
    set((s) => ({ lastSelfSave: { ...s.lastSelfSave, [key]: Date.now() } }));
    // Get the current user email so updated_by_email is populated even
    // when Postgres trigger context isn't available client-side.
    const sessionEmail = (await supabase.auth.getUser()).data.user?.email ?? null;
    const payload: Partial<SalaryRecordRow> = {
      employee_number: input.employee_number,
      period: input.period,
      grade_code: input.grade_code ?? null,
      career_track: input.career_track ?? null,
      evaluation_grade: input.evaluation_grade ?? null,
      base_salary: input.base_salary ?? null,
      fixed_overtime_allowance: input.fixed_overtime_allowance ?? null,
      comment: input.comment ?? null,
      updated_by_email: sessionEmail,
    };
    const { data, error } = await supabase
      .from("salary_records")
      .upsert(payload, { onConflict: "employee_number,period" })
      .select("*")
      .single();
    if (error || !data) return { ok: false, reason: error?.message ?? "保存失敗" };
    const row = data as SalaryRecordRow;
    set((s) => ({
      records: { ...s.records, [key]: row },
      recentEdits: { ...s.recentEdits, [key]: { at: Date.now() } },
    }));
    return { ok: true, row };
  },

  upsertGrade: async (input) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定" };
    const { error } = await supabase.from("grades").upsert(input, { onConflict: "code" });
    if (error) return { ok: false, reason: error.message };
    await get().refresh();
    return { ok: true };
  },

  setPeriodBudget: async (code, monthly_salary_budget) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定" };
    const { error } = await supabase
      .from("periods")
      .update({ monthly_salary_budget })
      .eq("code", code);
    if (error) return { ok: false, reason: error.message };
    set((s) => ({
      periods: s.periods.map((p) =>
        p.code === code ? { ...p, monthly_salary_budget } : p,
      ),
    }));
    return { ok: true };
  },

  setEmployeeCareerTrack: async (employee_number, track) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定" };
    const { error } = await supabase
      .from("employees")
      .update({ career_track: track })
      .eq("employee_number", employee_number);
    if (error) return { ok: false, reason: error.message };
    return { ok: true };
  },

  subscribe: () => {
    if (!isSupabaseConfigured || !supabase) return;
    if (get().channel) return;
    const channel = supabase.channel(SALARY_CHANNEL);

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "salary_records" },
      (payload) => {
        const newRow = (payload.new ?? payload.old) as SalaryRecordRow | undefined;
        if (!newRow) return;
        const key = recordKey(newRow.employee_number, newRow.period);
        // Suppress echo of our own writes
        const last = get().lastSelfSave[key];
        if (last && Date.now() - last < ECHO_WINDOW_MS) return;
        set((s) => {
          if (payload.eventType === "DELETE") {
            const next = { ...s.records };
            delete next[key];
            return { records: next };
          }
          return { records: { ...s.records, [key]: newRow } };
        });
      },
    );

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "grades" },
      () => { get().refresh(); },
    );

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "periods" },
      () => { get().refresh(); },
    );

    channel.subscribe();
    set({ channel });
  },

  unsubscribe: async () => {
    const ch = get().channel;
    if (ch) await ch.unsubscribe();
    set({ channel: null });
  },
}));

/** Convenience: look up a salary record by composite key. Returns null
 *  when no record exists yet for that (employee, period). */
export function getRecord(
  records: Record<string, SalaryRecordRow>,
  employee_number: string,
  period: PeriodCode,
): SalaryRecordRow | null {
  return records[`${employee_number}::${period}`] ?? null;
}

/** True if the cell was edited locally within the highlight window. */
export function isRecentlyEdited(
  recentEdits: Record<string, { at: number }>,
  employee_number: string,
  period: PeriodCode,
  windowMs = 8000,
): boolean {
  const e = recentEdits[`${employee_number}::${period}`];
  if (!e) return false;
  return Date.now() - e.at < windowMs;
}
