import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type {
  PulseMemberSummary,
  PulsePersonHistoryRow,
  PulseCareLogRow,
  PulsePersonAlertRow,
  PulseCareKind,
} from "../lib/pulse";

/**
 * P4-①: パルス メンバー（個人別回答推移）用ストア（#/pulse/members）。
 * 一覧・個人履歴とも rpc（0029・pulse_can_view_realname ゲート＋scope）。
 * canViewRealname はサブナビの「メンバー」タブ表示ゲートにも使う。
 * usePulseAlertsStore の作法を踏襲。
 */

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルスのメンバー機能が見つかりません。supabase/migrations/0029 を適用してください。";
const DENIED_MSG = "個人別の回答推移は実名閲覧権限者のみ閲覧できます。";

function isDenied(message: string | undefined): boolean {
  return !!message && /permission denied/i.test(message);
}

type PulseMembersState = {
  /** 実名閲覧権（メンバータブの表示ゲート）。null=未判定。 */
  canViewRealname: boolean | null;

  loaded: boolean;
  loading: boolean;
  error: string | null;
  members: PulseMemberSummary[];

  personLoading: boolean;
  personError: string | null;
  personEmp: string | null;
  personHistory: PulsePersonHistoryRow[];

  /** P4-③: 対応・面談ログ（can_manage_alert が無いユーザーは canCare=false）。 */
  canCare: boolean;
  careLogs: PulseCareLogRow[];
  personAlerts: PulsePersonAlertRow[];
  careSaving: boolean;

  checkRealname: () => Promise<void>;
  loadMembers: () => Promise<void>;
  loadPerson: (employeeNumber: string) => Promise<void>;
  addCareLog: (
    employeeNumber: string,
    kind: PulseCareKind,
    note: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  deleteCareLog: (
    employeeNumber: string,
    id: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
};

/** 対応ログ＋個人アラートを取得（権限なしは canCare=false で静かに空）。 */
async function fetchCareData(
  employeeNumber: string,
): Promise<{ canCare: boolean; careLogs: PulseCareLogRow[]; personAlerts: PulsePersonAlertRow[] }> {
  if (!supabase) return { canCare: false, careLogs: [], personAlerts: [] };
  const [logsRes, alertsRes] = await Promise.all([
    supabase.rpc("pulse_list_care_logs", { p_employee_number: employeeNumber }),
    supabase.rpc("pulse_person_alerts", { p_employee_number: employeeNumber }),
  ]);
  if (logsRes.error) {
    // permission denied / migration 未適用 → 対応ログ UI 自体を出さない
    return { canCare: false, careLogs: [], personAlerts: [] };
  }
  return {
    canCare: true,
    careLogs: (logsRes.data ?? []) as PulseCareLogRow[],
    personAlerts: alertsRes.error ? [] : ((alertsRes.data ?? []) as PulsePersonAlertRow[]),
  };
}

export const usePulseMembersStore = create<PulseMembersState>((set, get) => ({
  canViewRealname: null,
  loaded: false,
  loading: false,
  error: null,
  members: [],
  personLoading: false,
  personError: null,
  personEmp: null,
  personHistory: [],
  canCare: false,
  careLogs: [],
  personAlerts: [],
  careSaving: false,

  checkRealname: async () => {
    if (get().canViewRealname !== null) return;
    if (!isSupabaseConfigured || !supabase) {
      set({ canViewRealname: false });
      return;
    }
    const { data, error } = await supabase.rpc("pulse_can_view_realname");
    set({ canViewRealname: !error && data === true });
  },

  loadMembers: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });
    const { data, error } = await supabase.rpc("pulse_list_member_summaries");
    if (error) {
      set({
        loading: false,
        loaded: true,
        error: isDenied(error.message)
          ? DENIED_MSG
          : missingError(error.message)
            ? MISSING_MSG
            : error.message,
      });
      return;
    }
    set({
      loading: false,
      loaded: true,
      error: null,
      members: (data ?? []) as PulseMemberSummary[],
    });
  },

  loadPerson: async (employeeNumber) => {
    if (!isSupabaseConfigured || !supabase) {
      set({ personError: "Supabase未設定です" });
      return;
    }
    set({
      personLoading: true,
      personError: null,
      personEmp: employeeNumber,
      personHistory: [],
      careLogs: [],
      personAlerts: [],
    });
    const [historyRes, care] = await Promise.all([
      supabase.rpc("pulse_person_history", { p_employee_number: employeeNumber }),
      fetchCareData(employeeNumber),
    ]);
    if (historyRes.error) {
      set({
        personLoading: false,
        personError: isDenied(historyRes.error.message)
          ? DENIED_MSG
          : missingError(historyRes.error.message)
            ? MISSING_MSG
            : historyRes.error.message,
      });
      return;
    }
    set({
      personLoading: false,
      personHistory: (historyRes.data ?? []) as PulsePersonHistoryRow[],
      canCare: care.canCare,
      careLogs: care.careLogs,
      personAlerts: care.personAlerts,
    });
  },

  addCareLog: async (employeeNumber, kind, note) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ careSaving: true });
    const { error } = await supabase.rpc("pulse_add_care_log", {
      p_employee_number: employeeNumber,
      p_kind: kind,
      p_note: note,
    });
    if (error) {
      set({ careSaving: false });
      return { ok: false, reason: error.message };
    }
    const care = await fetchCareData(employeeNumber);
    set({ careSaving: false, careLogs: care.careLogs, personAlerts: care.personAlerts });
    return { ok: true };
  },

  deleteCareLog: async (employeeNumber, id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { error } = await supabase.rpc("pulse_delete_care_log", { p_id: id });
    if (error) return { ok: false, reason: error.message };
    const care = await fetchCareData(employeeNumber);
    set({ careLogs: care.careLogs, personAlerts: care.personAlerts });
    return { ok: true };
  },
}));
