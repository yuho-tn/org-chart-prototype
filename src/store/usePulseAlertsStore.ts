import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { usePulseCyclesStore } from "./usePulseCyclesStore";
import type {
  PulseCycleRow,
  PulseAlertRow,
  PulseActionState,
  PulseAlertReviewRow,
} from "../lib/pulse";

/**
 * パルスサーベイ アラート一覧＋対応管理＋振り返り（#/pulse/alerts）用ストア（設計書 §10-5〜§10-8）。
 * 一覧は rpc('pulse_list_alerts')（can_manage_alert ゲート・実名/コメント分類マスク・
 * own_unit は disclose_to_manager=true のみ・p_cycle_id=null で直近12サイクル分まとめて）。
 * 対応の書込みは rpc('pulse_bulk_update_alert_actions')（単票保存も1件配列で同じRPCを使う・
 * 旧 pulse_alert_actions への直接 upsert / pulse_set_alert_status の手動クローズ切替は廃止。
 * 状態(state)が done/not_needed になった時の open/closed 同期はDBトリガ任せ）。
 * 誤登録の削除は rpc('pulse_delete_alert_action')。再判定は rpc('pulse_evaluate_alerts')。
 * 振り返りタブは rpc('pulse_alert_review')。
 *
 * フィルタ（状態/ルール/担当/重要度）・行選択（一括更新チェックボックス）は表示専用の
 * ローカル state のため、PulseCommentsPage の検索/部署フィルタと同じ流儀でコンポーネント側
 * useState に持たせる（本ストアは取得済みの生 alerts 配列だけを持つ）。
 *
 * cycles / selectedPeriod は usePulseCyclesStore（共有・60秒キャッシュ）に委譲する
 * （ダッシュボード/コメント等と期間選択が同期する）。「すべて（直近12か月）」は本ストア
 * ローカルの periodMode で管理し、共有ストアの selectedPeriod は上書きしない（他画面の
 * 期間選択を巻き戻さないため）。
 */

type Result = { ok: boolean; reason?: string };
export type AssigneeOption = { employee_number: string; name: string };
export type PulseAlertPeriodMode = "period" | "all";

/** pulse_bulk_update_alert_actions の p_patch。含めたキーだけがサーバ側で反映される
 *  （省略したキーは「変更しない」＝一括更新バーのフィールド単位の任意適用を実現する）。 */
export type AlertActionPatch = Partial<{
  title: string | null;
  state: PulseActionState;
  assignee_employee_number: string | null;
  due_date: string | null;
  note: string | null;
}>;

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルスのアラート機能（P2）が見つかりません。supabase/migrations/0051 を適用してください。";

function cycleIdOf(cycles: PulseCycleRow[], period: string | null): string | null {
  return cycles.find((c) => c.period === period)?.id ?? null;
}

async function fetchAlerts(cycleId: string | null): Promise<PulseAlertRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("pulse_list_alerts", { p_cycle_id: cycleId });
  if (error) throw error;
  return (data ?? []) as PulseAlertRow[];
}

function fetchAlertsForScope(mode: PulseAlertPeriodMode, cycleId: string | null): Promise<PulseAlertRow[]> {
  if (mode === "all") return fetchAlerts(null);
  if (!cycleId) return Promise.resolve([]);
  return fetchAlerts(cycleId);
}

type PulseAlertsState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  evaluating: boolean;
  bulkUpdating: boolean;
  /** インライン編集・単票削除の対象alert_id（進行中はそのIDだけ）。 */
  busyId: string | null;

  cycles: PulseCycleRow[];
  /** 実期間（"すべて"選択中も直近の実期間を保持し、切替時の初期値に使う）。 */
  selectedPeriod: string | null;
  periodMode: PulseAlertPeriodMode;
  assignees: AssigneeOption[];
  alerts: PulseAlertRow[];

  tab: "alerts" | "review";
  review: PulseAlertReviewRow[];
  reviewLoading: boolean;
  reviewError: string | null;
  /** 直近に読み込んだ振り返りの対象period（再fetchループ防止）。 */
  reviewPeriod: string | null;

  load: () => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
  selectAllPeriods: () => Promise<void>;
  setTab: (tab: "alerts" | "review") => void;
  refresh: () => Promise<void>;
  reevaluate: () => Promise<Result>;
  /** 単票保存も一括更新も同じRPC（alertIds 1件 or 複数・最大50件）。 */
  bulkUpdate: (alertIds: string[], patch: AlertActionPatch) => Promise<Result>;
  deleteAction: (alertId: string) => Promise<Result>;
  loadReview: (period: string) => Promise<void>;
};

export const usePulseAlertsStore = create<PulseAlertsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  evaluating: false,
  bulkUpdating: false,
  busyId: null,
  cycles: [],
  selectedPeriod: null,
  periodMode: "period",
  assignees: [],
  alerts: [],

  tab: "alerts",
  review: [],
  reviewLoading: false,
  reviewError: null,
  reviewPeriod: null,

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const [, empRes] = await Promise.all([
      usePulseCyclesStore.getState().loadCycles(),
      supabase
        .from("employees")
        .select("employee_number, display_name, full_name")
        .is("left_at", null)
        .order("employee_number", { ascending: true }),
    ]);

    const cyclesState = usePulseCyclesStore.getState();
    if (cyclesState.error) {
      set({
        loading: false,
        loaded: true,
        error: missingError(cyclesState.error) ? MISSING_MSG : cyclesState.error,
      });
      return;
    }

    const cycles = cyclesState.cycles;
    const assignees = ((empRes.data ?? []) as {
      employee_number: string;
      display_name: string | null;
      full_name: string | null;
    }[]).map((e) => ({
      employee_number: e.employee_number,
      name: e.display_name ?? e.full_name ?? e.employee_number,
    }));

    const period = cyclesState.selectedPeriod;
    const { periodMode } = get();
    const cycleId = cycleIdOf(cycles, period);
    let alerts: PulseAlertRow[];
    try {
      alerts = await fetchAlertsForScope(periodMode, cycleId);
    } catch (e) {
      const msg = (e as Error).message;
      set({ loading: false, loaded: true, error: missingError(msg) ? MISSING_MSG : msg });
      return;
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
    usePulseCyclesStore.getState().selectPeriod(period);
    const cycleId = cycleIdOf(get().cycles, period);
    set({ selectedPeriod: period, periodMode: "period", loading: true, error: null });
    try {
      const alerts = await fetchAlertsForScope("period", cycleId);
      set({ alerts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  selectAllPeriods: async () => {
    if (!supabase) return;
    set({ periodMode: "all", loading: true, error: null });
    try {
      const alerts = await fetchAlertsForScope("all", null);
      set({ alerts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  setTab: (tab) => set({ tab }),

  refresh: async () => {
    const { periodMode, cycles, selectedPeriod } = get();
    const cycleId = cycleIdOf(cycles, selectedPeriod);
    try {
      const alerts = await fetchAlertsForScope(periodMode, cycleId);
      set({ alerts });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },

  reevaluate: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { periodMode, cycles, selectedPeriod } = get();
    if (periodMode !== "period") {
      return { ok: false, reason: "「すべて」表示では再判定できません。対象月を選んでください" };
    }
    const cycleId = cycleIdOf(cycles, selectedPeriod);
    if (!cycleId) return { ok: false, reason: "対象サイクルがありません" };
    set({ evaluating: true });
    const { error } = await supabase.rpc("pulse_evaluate_alerts", { p_cycle_id: cycleId });
    set({ evaluating: false });
    if (error) return { ok: false, reason: missingError(error.message) ? MISSING_MSG : error.message };
    await get().refresh();
    return { ok: true };
  },

  bulkUpdate: async (alertIds, patch) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (alertIds.length === 0) return { ok: false, reason: "対象が選択されていません" };
    if (alertIds.length > 50) return { ok: false, reason: "一度に更新できるのは50件までです" };
    if (Object.keys(patch).length === 0) return { ok: false, reason: "変更する項目を指定してください" };
    set({ bulkUpdating: true, busyId: alertIds.length === 1 ? alertIds[0] : null });
    const { data, error } = await supabase.rpc("pulse_bulk_update_alert_actions", {
      p_alert_ids: alertIds,
      p_patch: patch,
    });
    set({ bulkUpdating: false, busyId: null });
    if (error) return { ok: false, reason: missingError(error.message) ? MISSING_MSG : error.message };
    await get().refresh();
    const n = typeof data === "number" ? data : alertIds.length;
    return { ok: true, reason: `${n}件を更新しました` };
  },

  deleteAction: async (alertId) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busyId: alertId });
    const { error } = await supabase.rpc("pulse_delete_alert_action", { p_alert_id: alertId });
    if (error) {
      set({ busyId: null });
      return { ok: false, reason: missingError(error.message) ? MISSING_MSG : error.message };
    }
    await get().refresh();
    set({ busyId: null });
    return { ok: true };
  },

  loadReview: async (period) => {
    if (!supabase) return;
    set({ reviewLoading: true, reviewError: null });
    const { data, error } = await supabase.rpc("pulse_alert_review", { p_period: period });
    if (error) {
      set({
        reviewLoading: false,
        reviewError: missingError(error.message) ? MISSING_MSG : error.message,
      });
      return;
    }
    set({
      reviewLoading: false,
      review: (data ?? []) as PulseAlertReviewRow[],
      reviewPeriod: period,
    });
  },
}));
