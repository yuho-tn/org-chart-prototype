import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type {
  PulseCycleRow,
  PulseQuestionRow,
  PulseAnswerInput,
  PulseMyResponse,
} from "../lib/pulse";

/**
 * パルスサーベイ 回答画面（#/survey）用ストア。useMissionsStore の作法を踏襲
 * — 表示時 fetch（ポーリングなし）、書込みは SECURITY DEFINER RPC 経由
 * （pulse_submit_response）。本人特定はサーバ専任なので、クライアントは
 * 自分の employee_number を持たず rpc('pulse_my_response') に委ねる。
 */

type SubmitResult = { ok: boolean; reason?: string };

function missingTableError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the (table|function)/i.test(message);
}

const MISSING_MSG =
  "パルスサーベイのテーブルが見つかりません。supabase/migrations/0021_pulse_survey.sql を適用してください。";

/** 回答対象社員の状態。null=未判定 / "not_target"=対象外 / "eligible"=対象。 */
export type Eligibility = "unknown" | "not_target" | "eligible";

/**
 * rpc('pulse_my_history') の1点（設計書 v2 §2-5）。ログイン本人の回答履歴を
 * period 昇順で返す。サンクス画面の「マイパルス」専用（他人のデータは入らない）。
 */
export type PulseMyHistoryPoint = {
  period: string;
  overall: number | null;
  by_category: Record<string, number> | null;
  nps: number | null;
  submitted_at: string | null;
};

type PulseState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /** 回答受付中（status='sent'）の最新サイクル。無ければ null。 */
  cycle: PulseCycleRow | null;
  questions: PulseQuestionRow[];

  eligibility: Eligibility;
  /** 既回答があれば true（プレフィル済み・締切内は上書き可）。 */
  alreadyAnswered: boolean;
  /** question_id → 回答（プレフィル・入力中の下書き共通）。 */
  answers: Record<string, PulseAnswerInput>;
  comment: string;

  submitting: boolean;
  /** 送信完了フラグ（サンクスビュー表示用）。 */
  submitted: boolean;

  /** マイパルス（本人の回答履歴・period 昇順）。未取得/履歴なしは空配列。 */
  history: PulseMyHistoryPoint[];
  historyLoaded: boolean;
  historyLoading: boolean;

  loadSurvey: () => Promise<void>;
  loadMyHistory: () => Promise<void>;
  setScore: (questionId: string, score: number) => void;
  setValueText: (questionId: string, value: string) => void;
  setComment: (comment: string) => void;
  submit: () => Promise<SubmitResult>;
};

export const usePulseStore = create<PulseState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  cycle: null,
  questions: [],
  eligibility: "unknown",
  alreadyAnswered: false,
  answers: {},
  comment: "",
  submitting: false,
  submitted: false,
  history: [],
  historyLoaded: false,
  historyLoading: false,

  loadSurvey: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    // 1. 受付中サイクル（最新の sent）。
    const { data: cycleData, error: cycleErr } = await supabase
      .from("pulse_cycles")
      .select("*")
      .eq("status", "sent")
      .order("period", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cycleErr) {
      set({
        loading: false,
        loaded: true,
        error: missingTableError(cycleErr.message) ? MISSING_MSG : cycleErr.message,
      });
      return;
    }
    const cycle = (cycleData ?? null) as PulseCycleRow | null;
    if (!cycle) {
      set({ loading: false, loaded: true, cycle: null, questions: [] });
      return;
    }

    // 2. 設問（active・並び順）と 3. 自分の回答（プレフィル）を並列取得。
    const [qRes, myRes] = await Promise.all([
      supabase
        .from("pulse_questions")
        .select("*")
        .eq("question_set_id", cycle.question_set_id)
        .eq("is_active", true)
        .order("sort_order", { ascending: true }),
      supabase.rpc("pulse_my_response", { p_cycle_id: cycle.id }),
    ]);

    if (qRes.error) {
      set({
        loading: false,
        loaded: true,
        error: missingTableError(qRes.error.message) ? MISSING_MSG : qRes.error.message,
      });
      return;
    }

    const questions = (qRes.data ?? []) as PulseQuestionRow[];
    const my = (myRes.data ?? null) as PulseMyResponse | null;

    // my===null → 対象外社員。my.response===null → 対象だが未回答。
    const eligibility: Eligibility = my === null ? "not_target" : "eligible";
    const answers: Record<string, PulseAnswerInput> = {};
    if (my) {
      for (const a of my.answers ?? []) answers[a.question_id] = a;
    }

    set({
      loading: false,
      loaded: true,
      error: myRes.error && !missingTableError(myRes.error.message) ? myRes.error.message : null,
      cycle,
      questions,
      eligibility,
      alreadyAnswered: !!my?.response,
      answers,
      comment: my?.response?.comment ?? "",
      submitted: false,
    });
  },

  /**
   * マイパルス取得（rpc: pulse_my_history）。本人データのみを返す RPC なので
   * 権限ゲートは不要。migration 未適用・対象外社員（戻りが null）の場合は
   * 空配列にして黙って非表示にする — 回答体験を邪魔しないため。
   */
  loadMyHistory: async () => {
    if (!supabase || get().historyLoading) return;
    set({ historyLoading: true });
    const { data, error } = await supabase.rpc("pulse_my_history");
    set({
      historyLoading: false,
      historyLoaded: true,
      history: !error && Array.isArray(data) ? (data as PulseMyHistoryPoint[]) : [],
    });
  },

  setScore: (questionId, score) =>
    set((s) => ({
      answers: {
        ...s.answers,
        [questionId]: {
          question_id: questionId,
          score,
          value_text: s.answers[questionId]?.value_text ?? null,
        },
      },
    })),

  setValueText: (questionId, value) =>
    set((s) => ({
      answers: {
        ...s.answers,
        [questionId]: {
          question_id: questionId,
          score: s.answers[questionId]?.score ?? null,
          value_text: value,
        },
      },
    })),

  setComment: (comment) => set({ comment }),

  submit: async () => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { cycle, questions, answers, comment } = get();
    if (!cycle) return { ok: false, reason: "回答受付中のサーベイがありません" };

    // 送信ペイロード: 入力のある設問のみ（question_id をキーに整形）。
    const payload: PulseAnswerInput[] = questions
      .map((q) => answers[q.id])
      .filter((a): a is PulseAnswerInput => !!a && (a.score != null || !!a.value_text));

    set({ submitting: true });
    const { error } = await supabase.rpc("pulse_submit_response", {
      p_cycle_id: cycle.id,
      p_answers: payload,
      p_comment: comment.trim() || null,
    });
    set({ submitting: false });
    if (error) {
      return {
        ok: false,
        reason: missingTableError(error.message) ? MISSING_MSG : error.message,
      };
    }
    // historyLoaded を落として、サンクス画面のマイパルスに今回の回答を反映させる。
    set({ submitted: true, alreadyAnswered: true, historyLoaded: false });
    return { ok: true };
  },
}));
