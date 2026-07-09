import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PulseCycleRow, PulseCommentRow } from "../lib/pulse";

/**
 * パルスサーベイ コメント一覧（#/pulse/comments）用ストア。
 * rpc('pulse_list_comments')（admin or pulse_access 保有者・実名/匿名マスク・
 * 小集団 n<5 マスク・scope）を読む。usePulseDashStore の作法を踏襲。
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

  load: () => Promise<void>;
  selectPeriod: (period: string) => Promise<void>;
};

function cycleIdOf(cycles: PulseCycleRow[], period: string | null): string | null {
  return cycles.find((c) => c.period === period)?.id ?? null;
}

async function fetchComments(cycleId: string): Promise<PulseCommentRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc("pulse_list_comments", { p_cycle_id: cycleId });
  if (error) throw error;
  return (data ?? []) as PulseCommentRow[];
}

export const usePulseCommentsStore = create<PulseCommentsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  cycles: [],
  selectedPeriod: null,
  comments: [],

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const cyclesRes = await supabase
      .from("pulse_cycles")
      .select("*")
      .order("period", { ascending: false });

    if (cyclesRes.error) {
      set({
        loading: false,
        loaded: true,
        error: missingError(cyclesRes.error.message) ? MISSING_MSG : cyclesRes.error.message,
      });
      return;
    }

    const cycles = (cyclesRes.data ?? []) as PulseCycleRow[];
    const period = get().selectedPeriod ?? cycles[0]?.period ?? null;
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

    set({ loading: false, loaded: true, error: null, cycles, selectedPeriod: period, comments });
  },

  selectPeriod: async (period) => {
    if (!supabase) return;
    const cycleId = cycleIdOf(get().cycles, period);
    set({ selectedPeriod: period, loading: true, error: null });
    if (!cycleId) {
      set({ loading: false, comments: [] });
      return;
    }
    try {
      const comments = await fetchComments(cycleId);
      set({ comments, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },
}));
