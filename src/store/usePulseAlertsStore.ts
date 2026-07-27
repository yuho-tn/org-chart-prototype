import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PulseCycleRow, PulseAlertRow, PulseActionState } from "../lib/pulse";

/**
 * パルスサーベイ アラート一覧＋対応管理（#/pulse/alerts）用ストア。
 * 一覧は rpc('pulse_list_alerts')（can_manage_alert ゲート・実名マスク・scope）。
 * 対応レコードは pulse_alert_actions への直書き（0021 の insert/update RLS）で
 * 1アラート1件 upsert。status 切替は rpc('pulse_set_alert_status')。
 * 再判定は rpc('pulse_evaluate_alerts')。usePulseDashStore の作法を踏襲。
 */

type Result = { ok: boolean; reason?: string };
export type AssigneeOption = { employee_number: string; name: string };

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルスのアラート機能が見つかりません。supabase/migrations/0021+0024 を適用してください。";

export type ActionInput = {
  assignee_employee_number: string | null;
  state: PulseActionState;
  due_date: string | null;
  note: string | null;
};

type PulseAlertsState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  evaluating: boolean;
  busyId: string | null;

  cycles: PulseCycleRow[];
  selectedPeriod: string | null;
  assignees: AssigneeOption[];
  alerts: PulseAlertRow[];

  load: () => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
  reevaluate: () => Promise<Result>;
  setStatus: (alertId: string, status: "open" | "closed") => Promise<Result>;
  saveAction: (alertId: string, input: ActionInput) => Promise<Result>;
};

function cycleIdOf(cycles: PulseCycleRow[], period: string | null): string | null {
  return cycles.find((c) => c.period === period)?.id ?? null;
}

async function fetchAlerts(cycleId: string): Promise<PulseAlertRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("pulse_list_alerts", { p_cycle_id: cycleId });
  if (error) throw error;
  return (data ?? []) as PulseAlertRow[];
}

export const usePulseAlertsStore = create<PulseAlertsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  evaluating: false,
  busyId: null,
  cycles: [],
  selectedPeriod: null,
  assignees: [],
  alerts: [],

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const [cyclesRes, empRes] = await Promise.all([
      supabase.from("pulse_cycles").select("*").order("period", { ascending: false }),
      supabase
        .from("employees")
        .select("employee_number, display_name, full_name")
        .is("left_at", null)
        .order("employee_number", { ascending: true }),
    ]);

    if (cyclesRes.error) {
      set({
        loading: false,
        loaded: true,
        error: missingError(cyclesRes.error.message) ? MISSING_MSG : cyclesRes.error.message,
      });
      return;
    }

    const cycles = (cyclesRes.data ?? []) as PulseCycleRow[];
    const assignees = ((empRes.data ?? []) as {
      employee_number: string;
      display_name: string | null;
      full_name: string | null;
    }[]).map((e) => ({
      employee_number: e.employee_number,
      name: e.display_name ?? e.full_name ?? e.employee_number,
    }));

    const period = get().selectedPeriod ?? cycles[0]?.period ?? null;
    const cycleId = cycleIdOf(cycles, period);
    let alerts: PulseAlertRow[] = [];
    if (cycleId) {
      try {
        alerts = await fetchAlerts(cycleId);
      } catch (e) {
        const msg = (e as Error).message;
        set({ loading: false, loaded: true, error: missingError(msg) ? MISSING_MSG : msg });
        return;
      }
    }

    set({
      loading: false,
      loaded: true,
      error: null,
      cycles,
      selectedPeriod: period,
      assignees,
      alerts,
    });
  },

  selectPeriod: async (period) => {
    if (!supabase) return;
    const cycleId = cycleIdOf(get().cycles, period);
    set({ selectedPeriod: period, loading: true, error: null });
    if (!cycleId) {
      set({ loading: false, alerts: [] });
      return;
    }
    try {
      const alerts = await fetchAlerts(cycleId);
      set({ alerts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  reevaluate: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const cycleId = cycleIdOf(get().cycles, get().selectedPeriod);
    if (!cycleId) return { ok: false, reason: "対象サイクルがありません" };
    set({ evaluating: true });
    const { error } = await supabase.rpc("pulse_evaluate_alerts", { p_cycle_id: cycleId });
    set({ evaluating: false });
    if (error) return { ok: false, reason: missingError(error.message) ? MISSING_MSG : error.message };
    try {
      set({ alerts: await fetchAlerts(cycleId) });
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    return { ok: true };
  },

  setStatus: async (alertId, status) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const cycleId = cycleIdOf(get().cycles, get().selectedPeriod);
    set({ busyId: alertId });
    const { error } = await supabase.rpc("pulse_set_alert_status", {
      p_alert_id: alertId,
      p_status: status,
    });
    if (error) {
      set({ busyId: null });
      return { ok: false, reason: error.message };
    }
    try {
      if (cycleId) set({ alerts: await fetchAlerts(cycleId) });
    } catch (e) {
      set({ busyId: null });
      return { ok: false, reason: (e as Error).message };
    }
    set({ busyId: null });
    return { ok: true };
  },

  saveAction: async (alertId, input) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const cycleId = cycleIdOf(get().cycles, get().selectedPeriod);
    set({ busyId: alertId });
    const { error } = await supabase
      .from("pulse_alert_actions")
      .upsert(
        {
          alert_id: alertId,
          assignee_employee_number: input.assignee_employee_number,
          state: input.state,
          due_date: input.due_date,
          note: input.note,
        },
        { onConflict: "alert_id" },
      );
    if (error) {
      set({ busyId: null });
      return { ok: false, reason: error.message };
    }
    try {
      if (cycleId) set({ alerts: await fetchAlerts(cycleId) });
    } catch (e) {
      set({ busyId: null });
      return { ok: false, reason: (e as Error).message };
    }
    set({ busyId: null });
    return { ok: true };
  },
}));
