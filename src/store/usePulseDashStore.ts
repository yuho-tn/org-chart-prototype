import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { usePulseCyclesStore } from "./usePulseCyclesStore";
import type { PulseCycleRow, PulseAggregateRow, PulseAlertRow } from "../lib/pulse";

/**
 * パルスサーベイ 管理ダッシュボード（#/pulse）用ストア。
 * 集計は pulse_monthly_aggregates（RLS=pulse_access 保有者 or admin）を読む。
 * 脱識別済み＋n<5 マスク済み。再集計は rpc('pulse_compute_aggregates')。
 * useMissionsStore の作法を踏襲（表示時 fetch・エラー整形）。
 *
 * cycles / selectedPeriod は usePulseCyclesStore（共有・60秒キャッシュ）に委譲する。
 * 本storeの cycles/selectedPeriod フィールドは互換維持のため残すが、実体は
 * 共有storeからのミラーであり、#/pulse 配下の他ページと期間選択が同期する。
 *
 * v2 追加（設計書 §5）:
 *   • cycleStats … rpc('pulse_admin_cycle_stats')。ヒーローバーの「回答 N/M」。
 *     集計（aggregates）を計算していないサイクルでも回答数が出せる。
 *   • openAlerts … 選択サイクルの未対応アラート数（指標カード4枚目）。
 *   • 自動集計 … 集計が無い or サイクルが受付中(sent)なら compute を自動実行して
 *     silent 再取得する。権限エラー（pulse_access のみの閲覧者など）は黙って無視し、
 *     既存の集計だけを表示する（行き止まりを作らない）。
 *   • remindCycle / closeSelectedCycle … ヒーローバーの2アクション。
 */

type Result = { ok: boolean; reason?: string };

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルス集計が見つかりません。supabase/migrations/0021+0023 を適用してください。";

/** 同じ期間の自動集計を連打しないためのクールダウン（ms）。 */
const AUTO_COMPUTE_COOLDOWN_MS = 60_000;
const autoComputedAt: Record<string, number> = {};

export type PulseSummary = {
  summary: string;
  model: string | null;
  created_at: string;
  meta: { comment_count?: number; response_count?: number };
};

/** rpc('pulse_admin_cycle_stats') の1行。 */
export type PulseCycleStat = { cycle_id: string; responses: number; target: number };

/** pulse-notify Edge Function の counts（配信内訳）。 */
export type PulseNotifyCounts = {
  targets: number;
  slack_ok: number;
  slack_fail: number;
  email_ok: number;
  email_fail: number;
};

/** total 行の期別推移（古→新）。 */
export type PulseTrendPoint = {
  period: string;
  avg: number | null;
  enps: number | null;
  rate: number | null;
  n: number | null;
};

type PulseDashState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  recomputing: boolean;
  /** 自動集計の実行中（手動の recomputing とは分ける＝ボタン表示を邪魔しない）。 */
  autoComputing: boolean;
  summarizing: boolean;
  notifying: boolean;
  closing: boolean;

  cycles: PulseCycleRow[];
  selectedPeriod: string | null;

  /** 選択中 period の集計行（total + 各 dimension）。 */
  aggregates: PulseAggregateRow[];
  /** 全 period の total 行の推移（古い→新しい）。 */
  trend: PulseTrendPoint[];
  /** 選択中 period の AI 要約（未生成なら null）。 */
  summary: PulseSummary | null;
  /** AI要約の直近エラー（パネル内に親切表示する）。 */
  summaryError: string | null;

  /** cycle_id → 回答数/対象数（権限が無ければ空のまま）。 */
  cycleStats: Record<string, PulseCycleStat>;
  /** 選択サイクルの未対応アラート数（権限が無い/未判定なら null）。 */
  openAlerts: number | null;
  /** status='active' の設問セット数（オンボーディングの現在地判定用・不明なら null）。 */
  activeSetCount: number | null;
  /** 直近のリマインド配信の内訳（ヒーローバーに行内表示）。 */
  lastNotify: PulseNotifyCounts | null;

  loadDashboard: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
  recompute: () => Promise<Result>;
  generateSummary: () => Promise<Result>;
  remindCycle: () => Promise<Result>;
  closeSelectedCycle: () => Promise<Result>;
};

async function fetchSummary(period: string): Promise<PulseSummary | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("pulse_summaries")
    .select("summary, model, created_at, meta")
    .eq("period", period)
    .maybeSingle();
  if (error) return null; // 未生成・テーブル未適用は静かに null
  return (data as PulseSummary) ?? null;
}

async function fetchAggregates(period: string): Promise<PulseAggregateRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("pulse_monthly_aggregates")
    .select("*")
    .eq("period", period);
  if (error) throw error;
  return (data ?? []) as PulseAggregateRow[];
}

async function fetchTrend(): Promise<PulseTrendPoint[]> {
  if (!supabase) return [];
  const { data } = await supabase
    .from("pulse_monthly_aggregates")
    .select("period, metrics")
    .eq("dimension", "total")
    .order("period", { ascending: true });
  return ((data ?? []) as {
    period: string;
    metrics: { avg_overall?: number; enps?: number; response_rate?: number | null; n?: number };
  }[]).map((r) => ({
    period: r.period,
    avg: r.metrics?.avg_overall ?? null,
    enps: r.metrics?.enps ?? null,
    rate: r.metrics?.response_rate ?? null,
    n: r.metrics?.n ?? null,
  }));
}

/** ヒーローバー用の回答数/対象数。権限が無ければ空オブジェクト（表示は「—」）。 */
async function fetchCycleStats(): Promise<Record<string, PulseCycleStat>> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc("pulse_admin_cycle_stats");
  if (error) return {};
  const map: Record<string, PulseCycleStat> = {};
  for (const s of (data ?? []) as PulseCycleStat[]) map[s.cycle_id] = s;
  return map;
}

/** 未対応（status='open'）アラート数。権限が無ければ null。 */
async function fetchOpenAlerts(cycleId: string): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("pulse_list_alerts", { p_cycle_id: cycleId });
  if (error) return null;
  return ((data ?? []) as PulseAlertRow[]).filter((a) => a.status === "open").length;
}

/** status='active' の設問セット数。権限が無い/未適用なら null（＝判定不能）。 */
async function fetchActiveSetCount(): Promise<number | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("pulse_question_sets").select("id").eq("status", "active");
  if (error) return null;
  return (data ?? []).length;
}

/** Edge Function のエラー本文（{ error, detail }）を読み出す。読めなければ null。 */
async function readFunctionError(error: unknown): Promise<{ error?: string; detail?: string } | null> {
  const ctx = (error as { context?: unknown } | null)?.context as Response | undefined;
  if (!ctx || typeof ctx.json !== "function") return null;
  try {
    return (await ctx.json()) as { error?: string; detail?: string };
  } catch {
    return null;
  }
}

export const usePulseDashStore = create<PulseDashState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  recomputing: false,
  autoComputing: false,
  summarizing: false,
  notifying: false,
  closing: false,
  cycles: [],
  selectedPeriod: null,
  aggregates: [],
  trend: [],
  summary: null,
  summaryError: null,
  cycleStats: {},
  openAlerts: null,
  activeSetCount: null,
  lastNotify: null,

  loadDashboard: async (opts) => {
    const silent = opts?.silent ?? false;
    const force = opts?.force ?? false;
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    const client = supabase;
    if (!silent) set({ loading: true, error: null });

    const [, trend, cycleStats, activeSetCount] = await Promise.all([
      usePulseCyclesStore.getState().loadCycles(),
      fetchTrend(),
      fetchCycleStats(),
      fetchActiveSetCount(),
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
    const period = cyclesState.selectedPeriod;

    let aggregates: PulseAggregateRow[] = [];
    let summary: PulseSummary | null = null;
    let openAlerts: number | null = null;
    if (period) {
      try {
        aggregates = await fetchAggregates(period);
      } catch (e) {
        set({ loading: false, loaded: true, error: (e as Error).message });
        return;
      }
      summary = await fetchSummary(period);
      const cycleId = cycles.find((c) => c.period === period)?.id ?? null;
      if (cycleId) openAlerts = await fetchOpenAlerts(cycleId);
    }

    // 上の await 群（fetchAggregates/fetchSummary/fetchOpenAlerts）の実行中に
    // selectPeriod() が別期間へ切替えていた場合、period依存の値（selectedPeriod/
    // aggregates/summary/openAlerts）はここで上書きしない（古い期間のデータで
    // ユーザーの選択を巻き戻すバグを防ぐ）。cycles/trend/cycleStats/activeSetCount
    // は期間非依存なので常に反映してよい。
    const stillCurrent = usePulseCyclesStore.getState().selectedPeriod === period;

    set({
      loading: false,
      loaded: true,
      error: null,
      cycles,
      trend,
      cycleStats,
      activeSetCount,
      ...(stillCurrent ? { selectedPeriod: period, aggregates, summary, openAlerts } : {}),
    });

    // ── 自動集計（設計書 §5）──
    // 「集計がまだ無い」または「受付中サイクル＝回答が増え続ける」、または
    // force指定（受付終了直後の強制最終集計）なら再計算する。
    // 権限エラーは黙って無視（閲覧専用ユーザーでも表示は成立させる）。
    // stillCurrent が false（＝この呼び出し中に期間が切替わった）なら、もはや
    // 表示対象ではない古い期間の再計算はスキップする。
    if (period && stillCurrent) {
      const cycle = cycles.find((c) => c.period === period);
      const hasTotal = aggregates.some((a) => a.dimension === "total");
      const stale = Date.now() - (autoComputedAt[period] ?? 0) > AUTO_COMPUTE_COOLDOWN_MS;
      if ((!hasTotal || cycle?.status === "sent" || force) && stale) {
        autoComputedAt[period] = Date.now();
        set({ autoComputing: true });
        const { error } = await client.rpc("pulse_compute_aggregates", { p_period: period });
        if (error) {
          set({ autoComputing: false });
          return;
        }
        // 集計中にも期間が切替わりうるので、反映直前に再確認する。
        if (usePulseCyclesStore.getState().selectedPeriod !== period) {
          set({ autoComputing: false });
          return;
        }
        try {
          const [fresh, freshTrend] = await Promise.all([fetchAggregates(period), fetchTrend()]);
          if (usePulseCyclesStore.getState().selectedPeriod !== period) {
            set({ autoComputing: false, trend: freshTrend });
            return;
          }
          set({ autoComputing: false, aggregates: fresh, trend: freshTrend });
        } catch {
          set({ autoComputing: false });
        }
      }
    }
  },

  selectPeriod: async (period) => {
    if (!supabase) return;
    usePulseCyclesStore.getState().selectPeriod(period);
    set({ selectedPeriod: period, loading: true, summaryError: null, lastNotify: null });
    try {
      const aggregates = await fetchAggregates(period);
      const summary = await fetchSummary(period);
      const cycleId = get().cycles.find((c) => c.period === period)?.id ?? null;
      const openAlerts = cycleId ? await fetchOpenAlerts(cycleId) : null;
      set({ aggregates, summary, openAlerts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  recompute: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const period = get().selectedPeriod;
    if (!period) return { ok: false, reason: "対象期間がありません" };
    set({ recomputing: true });
    const { error } = await supabase.rpc("pulse_compute_aggregates", { p_period: period });
    set({ recomputing: false });
    if (error) {
      return { ok: false, reason: missingError(error.message) ? MISSING_MSG : error.message };
    }
    autoComputedAt[period] = Date.now(); // 直後の自動集計と二重実行しない
    await get().loadDashboard({ silent: true });
    return { ok: true };
  },

  generateSummary: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const period = get().selectedPeriod;
    const cycleId = get().cycles.find((c) => c.period === period)?.id ?? null;
    if (!cycleId) return { ok: false, reason: "対象サイクルがありません" };
    set({ summarizing: true, summaryError: null });
    const { data, error } = await supabase.functions.invoke("pulse-summary", {
      body: { cycle_id: cycleId },
    });
    set({ summarizing: false });

    if (error) {
      const body = await readFunctionError(error);
      const reason = summaryErrorMessage(body?.error);
      set({ summaryError: reason });
      return { ok: false, reason };
    }
    if (data?.error) {
      const reason = summaryErrorMessage(String(data.error));
      set({ summaryError: reason });
      return { ok: false, reason };
    }
    if (period) set({ summary: await fetchSummary(period) });
    return { ok: true };
  },

  remindCycle: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const period = get().selectedPeriod;
    const cycleId = get().cycles.find((c) => c.period === period)?.id ?? null;
    if (!cycleId) return { ok: false, reason: "対象サイクルがありません" };
    set({ notifying: true, lastNotify: null });
    const { data, error } = await supabase.functions.invoke("pulse-notify", {
      body: { cycle_id: cycleId, mode: "reminder" },
    });
    set({ notifying: false });

    if (error) {
      const body = await readFunctionError(error);
      return { ok: false, reason: notifyErrorMessage(body?.error) };
    }
    if (data?.error) return { ok: false, reason: notifyErrorMessage(String(data.error)) };

    const counts = (data?.counts ?? null) as PulseNotifyCounts | null;
    if (counts) set({ lastNotify: counts });
    // 回答数は変わらないが、送信直後の状態を最新化しておく。
    await get().loadDashboard({ silent: true });
    return {
      ok: true,
      reason: counts
        ? `リマインドを送信しました（対象${counts.targets}名・Slack ${counts.slack_ok}／メール ${counts.email_ok}）`
        : "リマインドを送信しました",
    };
  },

  closeSelectedCycle: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const period = get().selectedPeriod;
    const cycleId = get().cycles.find((c) => c.period === period)?.id ?? null;
    if (!cycleId) return { ok: false, reason: "対象サイクルがありません" };
    set({ closing: true });
    const { error } = await supabase.from("pulse_cycles").update({ status: "closed" }).eq("id", cycleId);
    set({ closing: false });
    if (error) {
      return {
        ok: false,
        reason: /permission|row-level security/i.test(error.message)
          ? "受付終了の権限がありません（管理者のみ）"
          : error.message,
      };
    }
    usePulseCyclesStore.getState().invalidate();
    if (period) delete autoComputedAt[period]; // 締切直後は必ず最終集計を回す
    // status が 'sent'→'closed' に変わると自動集計の通常条件（!hasTotal || status==='sent'）
    // を満たさなくなる（既に一度でも集計済みなら hasTotal=true・status はもう 'sent' ではない）。
    // force で明示的にバイパスし、締切直後の駆け込み回答を確実に反映する。
    await get().loadDashboard({ silent: true, force: true });
    return { ok: true, reason: "受付を終了しました。最終集計を実行しています" };
  },
}));

/** AI要約の生エラーを、次アクションが分かる日本語に整形する。 */
function summaryErrorMessage(raw: string | undefined): string {
  if (raw && /ANTHROPIC_API_KEY/i.test(raw)) {
    return "APIキー未設定です。docs/PULSE_ACTIVATION_RUNBOOK.md を参照して ANTHROPIC_API_KEY を登録してください。";
  }
  if (raw && /permission denied/i.test(raw)) {
    return "AI要約を生成する権限がありません（アラート管理権限が必要です）。";
  }
  if (raw && /anthropic error/i.test(raw)) {
    return "Claude API がエラーを返しました。時間をおいて再実行してください。";
  }
  if (raw) return `要約の生成に失敗しました：${raw}`;
  return "要約の生成に失敗しました（Edge Function 未デプロイ、または鍵未設定の可能性）";
}

/** 配信の生エラーを、次アクションが分かる日本語に整形する。 */
function notifyErrorMessage(raw: string | undefined): string {
  if (raw && /no_channel_configured/i.test(raw)) {
    return "配信チャネル未設定（Runbook参照）。回答URLを手動でSlack投稿してください。";
  }
  if (raw && /not open for answers/i.test(raw)) {
    return "受付中のサイクルではないため配信できません。";
  }
  if (raw && /permission denied/i.test(raw)) {
    return "配信する権限がありません（管理者のみ）。";
  }
  if (raw) return `配信に失敗しました：${raw}`;
  return "配信に失敗しました（Edge Function 未デプロイ、または Slack/メールの secret 未設定の可能性）";
}
