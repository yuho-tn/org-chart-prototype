import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { usePulseCyclesStore } from "./usePulseCyclesStore";
import type { PulseCycleRow, PulseCommentRow, PulseCommentClassification } from "../lib/pulse";
import { fetchSafe } from "../lib/query";

/**
 * パルスサーベイ コメント一覧（#/pulse/comments）用ストア。
 * rpc('pulse_list_comments')（admin or pulse_access 保有者・実名/匿名マスク・
 * 小集団 n<5 マスク・scope）を読む。usePulseDashStore の作法を踏襲。
 *
 * cycles / selectedPeriod は usePulseCyclesStore（共有・60秒キャッシュ）に委譲する
 * （ダッシュボード/アラート等と期間選択が同期する）。
 *
 * P2（設計書 §10-8）: 取得した comments の response_id 群で pulse_comment_classifications を
 * 直読し（1回・.in()）、response_id→分類 の map を持つ。RLS は人事（realname権限）のみ許可
 * のため、権限がない/未適用の場合は静かに空 map のまま（エラー表示もチップ表示もしない）。
 */

function missingError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}
const MISSING_MSG =
  "パルスのコメント機能が見つかりません。supabase/migrations/0021+0025 を適用してください。";

type PulseCommentsState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;

  cycles: PulseCycleRow[];
  selectedPeriod: string | null;
  comments: PulseCommentRow[];
  /** response_id → コメント分類（人事のみ非空・他は常に {}）。 */
  classifications: Record<string, PulseCommentClassification>;

  load: () => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
};

function cycleIdOf(cycles: PulseCycleRow[], period: string | null): string | null {
  return cycles.find((c) => c.period === period)?.id ?? null;
}

async function fetchComments(cycleId: string): Promise<PulseCommentRow[]> {
  if (!supabase) return [];
  const { data, error } = await fetchSafe(() => supabase!.rpc("pulse_list_comments", { p_cycle_id: cycleId }));
  if (error) throw error;
  return (data ?? []) as PulseCommentRow[];
}

/** response_id → コメント分類。RLSで0行/未適用なら黙って空map（チップを出さないだけ）。 */
async function fetchClassifications(
  responseIds: string[],
): Promise<Record<string, PulseCommentClassification>> {
  if (!supabase || responseIds.length === 0) return {};
  const { data, error } = await supabase
    .from("pulse_comment_classifications")
    .select("response_id, categories, primary_category, severity, summary")
    .in("response_id", responseIds);
  if (error) return {};
  const map: Record<string, PulseCommentClassification> = {};
  for (const row of (data ?? []) as PulseCommentClassification[]) map[row.response_id] = row;
  return map;
}

export const usePulseCommentsStore = create<PulseCommentsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  cycles: [],
  selectedPeriod: null,
  comments: [],
  classifications: {},

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    await usePulseCyclesStore.getState().loadCycles();
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
    const cycleId = cycleIdOf(cycles, period);
    let comments: PulseCommentRow[] = [];
    if (cycleId) {
      try {
        comments = await fetchComments(cycleId);
      } catch (e) {
        const msg = (e as Error).message;
        set({ loading: false, loaded: true, error: missingError(msg) ? MISSING_MSG : msg });
        return;
      }
    }
    const classifications = await fetchClassifications(comments.map((c) => c.response_id));

    set({
      loading: false,
      loaded: true,
      error: null,
      cycles,
      selectedPeriod: period,
      comments,
      classifications,
    });
  },

  selectPeriod: async (period) => {
    if (!supabase) return;
    usePulseCyclesStore.getState().selectPeriod(period);
    const cycleId = cycleIdOf(get().cycles, period);
    set({ selectedPeriod: period, loading: true, error: null });
    if (!cycleId) {
      set({ loading: false, comments: [], classifications: {} });
      return;
    }
    try {
      const comments = await fetchComments(cycleId);
      const classifications = await fetchClassifications(comments.map((c) => c.response_id));
      set({ comments, classifications, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
}));
