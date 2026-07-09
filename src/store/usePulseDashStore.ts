import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PulseCycleRow, PulseAggregateRow } from "../lib/pulse";

/**
 * パルスサーベイ 管理ダッシュボード（#/pulse）用ストア。
 * 集計は pulse_monthly_aggregates（RLS=pulse_access 保有者 or admin）を読む。
 * 脱識別済み＋n<5 マスク済み。再集計は rpc('pulse_compute_aggregates')。
 * useMissionsStore の作法を踏襲（表示時 fetch・エラー整形）。
 */

type Result = { ok: boolean; reason?: string };

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルス集計が見つかりません。supabase/migrations/0021+0023 を適用してください。";

type PulseDashState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  recomputing: boolean;

  cycles: PulseCycleRow[];
  selectedPeriod: string | null;

  /** 選択中 period の集計行（total + 各 dimension）。 */
  aggregates: PulseAggregateRow[];
  /** 全 period の total.avg_overall 推移（古い→新しい）。 */
  trend: { period: string; avg: number | null }[];

  loadDashboard: () => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
  recompute: () => Promise<Result>;
};

async function fetchAggregates(period: string): Promise<PulseAggregateRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from("pulse_monthly_aggregates")
    .select("*")
    .eq("period", period);
  if (error) throw error;
  return (data ?? []) as PulseAggregateRow[];
}

export const usePulseDashStore = create<PulseDashState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  recomputing: false,
  cycles: [],
  selectedPeriod: null,
  aggregates: [],
  trend: [],

  loadDashboard: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const [cyclesRes, trendRes] = await Promise.all([
      supabase.from("pulse_cycles").select("*").order("period", { ascending: false }),
      supabase
        .from("pulse_monthly_aggregates")
        .select("period, metrics")
        .eq("dimension", "total")
        .order("period", { ascending: true }),
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
    const trend = ((trendRes.data ?? []) as { period: string; metrics: { avg_overall?: number } }[])
      .map((r) => ({ period: r.period, avg: r.metrics?.avg_overall ?? null }));

    const period = get().selectedPeriod ?? cycles[0]?.period ?? null;
    let aggregates: PulseAggregateRow[] = [];
    if (period) {
      try {
        aggregates = await fetchAggregates(period);
      } catch (e) {
        set({ loading: false, loaded: true, error: (e as Error).message });
        return;
      }
    }

    set({
      loading: false,
      loaded: true,
      error: null,
      cycles,
      selectedPeriod: period,
      aggregates,
      trend,
    });
  },

  selectPeriod: async (period) => {
    if (!supabase) return;
    set({ selectedPeriod: period, loading: true });
    try {
      const aggregates = await fetchAggregates(period);
      set({ aggregates, loading: false });
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
    await get().loadDashboard();
    return { ok: true };
  },
}));
