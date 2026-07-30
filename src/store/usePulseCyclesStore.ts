import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PulseCycleRow } from "../lib/pulse";

/**
 * パルスサーベイ cycles 一覧 ＋ selectedPeriod の一元管理ストア（設計書 v2 §3）。
 * usePulseDashStore / usePulseAlertsStore / usePulseCommentsStore / usePulseAdminStore が
 * 個別に持っていた「pulse_cycles取得」「selectedPeriod保持」の重複実装をここへ集約する。
 * 各ページstoreは自分の load()/selectPeriod() 内でこのストアを参照・更新し、
 * 自ストアの cycles/selectedPeriod フィールドへミラーする（公開APIは互換維持）。
 * これにより #/pulse 配下の画面間で期間選択が同期する。
 *
 * キャッシュ: 60秒以内の loadCycles() 再呼び出しは fetch を行わずキャッシュを返す
 * （#/pulse サブページ間のタブ切替のたびに毎回 pulse_cycles を叩かないため）。
 * サイクルを作成/送信/締切するなど pulse_cycles 自体を変更した直後は invalidate() を
 * 呼んでから再度 loadCycles() することで即時反映する。
 */

const STALE_MS = 60_000;

type PulseCyclesState = {
  cycles: PulseCycleRow[];
  selectedPeriod: string | null;
  loaded: boolean;
  loading: boolean;
  /** 直近 fetch の生エラーメッセージ（未整形）。呼び出し側が自分の文言でラップする。 */
  error: string | null;
  lastFetchedAt: number | null;

  /** cycles をロードする。60秒以内かつ force 未指定なら fetch をスキップする。 */
  loadCycles: (opts?: { force?: boolean }) => Promise<void>;
  /** 選択期間を切替える（全pulseページで共通・同期される）。 */
  selectPeriod: (period: string) => void;
  /** 次回 loadCycles を強制再fetchにする（サイクル作成/送信/締切の直後などに呼ぶ）。 */
  invalidate: () => void;
};

// 複数storeがほぼ同時に loadCycles() を呼んだ場合に fetch を1本化するためのモジュール内共有Promise。
let inflight: Promise<void> | null = null;

export const usePulseCyclesStore = create<PulseCyclesState>((set, get) => ({
  cycles: [],
  selectedPeriod: null,
  loaded: false,
  loading: false,
  error: null,
  lastFetchedAt: null,

  loadCycles: async (opts) => {
    const force = opts?.force ?? false;
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    const { lastFetchedAt } = get();
    if (!force && lastFetchedAt !== null && Date.now() - lastFetchedAt < STALE_MS) {
      return;
    }
    if (inflight) {
      await inflight;
      return;
    }

    const client = supabase;
    inflight = (async () => {
      set({ loading: true, error: null });
      const { data, error } = await client
        .from("pulse_cycles")
        .select("*")
        .order("period", { ascending: false });

      if (error) {
        set({ loading: false, loaded: true, error: error.message });
        return;
      }

      const cycles = (data ?? []) as PulseCycleRow[];
      const prevSelected = get().selectedPeriod;
      const selectedPeriod =
        prevSelected && cycles.some((c) => c.period === prevSelected)
          ? prevSelected
          : (cycles[0]?.period ?? null);

      set({
        loading: false,
        loaded: true,
        error: null,
        cycles,
        selectedPeriod,
        lastFetchedAt: Date.now(),
      });
    })();

    try {
      await inflight;
    } finally {
      inflight = null;
    }
  },

  selectPeriod: (period) => set({ selectedPeriod: period }),

  invalidate: () => set({ lastFetchedAt: null }),
}));
