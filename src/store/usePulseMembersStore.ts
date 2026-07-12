import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PulseMemberSummary, PulsePersonHistoryRow } from "../lib/pulse";

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

  checkRealname: () => Promise<void>;
  loadMembers: () => Promise<void>;
  loadPerson: (employeeNumber: string) => Promise<void>;
};

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
    });
    const { data, error } = await supabase.rpc("pulse_person_history", {
      p_employee_number: employeeNumber,
    });
    if (error) {
      set({
        personLoading: false,
        personError: isDenied(error.message)
          ? DENIED_MSG
          : missingError(error.message)
            ? MISSING_MSG
            : error.message,
      });
      return;
    }
    set({
      personLoading: false,
      personHistory: (data ?? []) as PulsePersonHistoryRow[],
    });
  },
}));
