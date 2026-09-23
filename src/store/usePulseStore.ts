import { create } from "zustand";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import {
  PULSE_ANSWER_ERROR_MESSAGE,
  type PulseAnswerInput,
  type PulseAnswerErrorCode,
  type PulseSurveyBundle,
  type PulseSurveyBundleCycle,
  type PulseSurveyBundleQuestion,
  type PulseSurveyPrevious,
  type PulseSurveyViewers,
} from "../lib/pulse";
import { fetchSafe } from "../lib/query";

/**
 * パルスサーベイ 回答画面（#/survey・#/survey?t=<token>）用ストア（v3 P1）。
 *
 * 二経路:
 *   - token モード（未ログイン可）: Edge Function `pulse-answer` を anon key で呼ぶ
 *     （action="get"|"submit"）。本人特定はトークンが担う。
 *   - セッションモード（従来どおり）: rpc('pulse_my_survey') / rpc('pulse_submit_response')。
 *     本人特定は pulse_current_employee_number() に委ねる。
 * どちらも同じ bundle 形（PulseSurveyBundle・設計書 §3-4）を返すので、state への反映は
 * bundleToFields() に一本化している。pulse_cycles / pulse_questions の直読みはしない
 * （RLS が締まるため・設計書 §3-10）。
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
 * rpc('pulse_my_history') の1点（設計書 v3 §3-7 拡張版）。ログイン本人の回答履歴を
 * period 昇順で返す。サンクス画面の「マイパルス」／#/survey/history 専用（他人のデータは入らない）。
 * cycle_id / sum_score / comment は v3 で追加されたキー — 旧デプロイとの互換のため任意にしている。
 */
export type PulseMyHistoryPoint = {
  period: string;
  cycle_id?: string;
  overall: number | null;
  by_category: Record<string, number> | null;
  nps: number | null;
  sum_score?: number | null;
  comment?: string | null;
  submitted_at: string | null;
};

/**
 * submit 中に起こりうるエラーコードのうち、token/cycle/対象者そのものが無効に
 * なったことを意味する「終端」コード（再送信しても直らない＝フォームを畳んで
 * 専用の案内画面へ切り替える）。"submit_failed"（RPCのバリデーション例外・実測:
 * pulse-answer/index.ts が raw な例外文言を detail に載せて返す）はこの回答の
 * 内容固有の失敗であって token/cycle は生きているため、意図的に含めない
 * （フォームを残してトーストのみで知らせる）。
 */
const TERMINAL_SUBMIT_CODES: ReadonlySet<PulseAnswerErrorCode> = new Set([
  "invalid_token",
  "expired",
  "closed",
  "not_target",
  "not_found",
]);

/** Edge `pulse-answer` の FunctionsHttpError 本文から既知のエラーコードを取り出す。
 *  未知の形・非JSON・ネットワーク層のエラー（FunctionsFetchError 等）は null。 */
async function extractPulseAnswerErrorCode(error: unknown): Promise<PulseAnswerErrorCode | null> {
  if (!(error instanceof FunctionsHttpError)) return null;
  try {
    const body = await error.context.json();
    const code = body?.error;
    return typeof code === "string" && code in PULSE_ANSWER_ERROR_MESSAGE
      ? (code as PulseAnswerErrorCode)
      : null;
  } catch {
    return null;
  }
}

type ApplyBundleFields = {
  loading: boolean;
  loaded: boolean;
  error: string | null;
  tokenErrorCode: PulseAnswerErrorCode | null;
  cycle: PulseSurveyBundleCycle | null;
  questions: PulseSurveyBundleQuestion[];
  eligibility: Eligibility;
  alreadyAnswered: boolean;
  answers: Record<string, PulseAnswerInput>;
  comment: string;
  displayName: string | null;
  viewers: PulseSurveyViewers | null;
  previous: PulseSurveyPrevious | null;
  submitted: boolean;
};

/** bundle（または null／{cycle:null} 最小形）を state へ反映する共通ロジック。 */
function bundleToFields(bundle: PulseSurveyBundle | null): ApplyBundleFields {
  if (!bundle || !bundle.cycle) {
    return {
      loading: false,
      loaded: true,
      error: null,
      tokenErrorCode: null,
      cycle: null,
      questions: [],
      // bundle が null＝本人特定不可（対象外扱い）。bundle はあるが cycle が
      // null＝受付中サイクルが無いだけ（本人は対象外ではない）。
      eligibility: bundle ? "eligible" : "not_target",
      alreadyAnswered: false,
      answers: {},
      comment: "",
      displayName: bundle?.display_name ?? null,
      viewers: null,
      previous: null,
      submitted: false,
    };
  }
  const answers: Record<string, PulseAnswerInput> = {};
  for (const a of bundle.answers ?? []) answers[a.question_id] = a;
  return {
    loading: false,
    loaded: true,
    error: null,
    tokenErrorCode: null,
    cycle: bundle.cycle,
    questions: bundle.questions ?? [],
    eligibility: bundle.is_target === false ? "not_target" : "eligible",
    alreadyAnswered: !!bundle.response,
    answers,
    comment: bundle.response?.comment ?? "",
    displayName: bundle.display_name ?? null,
    viewers: bundle.viewers ?? null,
    previous: bundle.previous ?? null,
    submitted: false,
  };
}

type PulseState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** token モードで Edge が返した既知のエラーコード。session モードでは常に null。 */
  tokenErrorCode: PulseAnswerErrorCode | null;
  /** 現在の読み込みモード。loadSurvey({token}) で設定し、引数無しの再読込・submit()
   *  はこの値を見てどちらの経路を使うか決める。 */
  token: string | null;

  /** 回答受付中（status='sent'）のサイクル（bundle.cycle のサブセット）。無ければ null。 */
  cycle: PulseSurveyBundleCycle | null;
  questions: PulseSurveyBundleQuestion[];

  eligibility: Eligibility;
  /** 既回答があれば true（プレフィル済み・締切内は上書き可）。 */
  alreadyAnswered: boolean;
  /** question_id → 回答（プレフィル・入力中の下書き共通）。 */
  answers: Record<string, PulseAnswerInput>;
  comment: string;

  /** 回答者の表示名（bundle.display_name）。token モードでセッション情報が無い時の表示用。 */
  displayName: string | null;
  /** 閲覧者の明示（決定1）。bundle が cycle 付きで取れた時のみ非null。 */
  viewers: PulseSurveyViewers | null;
  /** 前回との比較用（カテゴリ別平均＋eNPS）。前回回答が無ければ null。 */
  previous: PulseSurveyPrevious | null;

  submitting: boolean;
  /** 送信完了フラグ（サンクスビュー表示用）。 */
  submitted: boolean;

  /** マイパルス（本人の回答履歴・period 昇順）。未取得/履歴なしは空配列。 */
  history: PulseMyHistoryPoint[];
  historyLoaded: boolean;
  historyLoading: boolean;

  /** token を渡せば token モード、opts省略なら現在のモード（token有無）を維持して再読込。 */
  loadSurvey: (opts?: { token?: string }) => Promise<void>;
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
  tokenErrorCode: null,
  token: null,
  cycle: null,
  questions: [],
  eligibility: "unknown",
  alreadyAnswered: false,
  answers: {},
  comment: "",
  displayName: null,
  viewers: null,
  previous: null,
  submitting: false,
  submitted: false,
  history: [],
  historyLoaded: false,
  historyLoading: false,

  loadSurvey: async (opts) => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    // opts が渡された時だけモードを更新する。引数無しの再読込（「再読み込み」
    // 「回答を見直す」ボタン等）は直前のモード（token の有無）をそのまま使う。
    const token = opts !== undefined ? (opts.token ?? null) : get().token;
    set({ loading: true, error: null, tokenErrorCode: null, token });
    try {

      if (token) {
        const { data, error } = await supabase.functions.invoke<{
          ok: boolean;
          bundle: PulseSurveyBundle;
        }>("pulse-answer", { body: { t: token, action: "get" } });
        if (error) {
          const code = await extractPulseAnswerErrorCode(error);
          // eligibility/questions もリセットする: 直前の読み込みが成功していた場合
          // （例: 一度 not_target で取れた後、再読込が期限切れで失敗した等）に、
          // 古い値がこのエラー状態と重複表示されないようにする。
          set({
            loading: false,
            loaded: true,
            cycle: null,
            questions: [],
            eligibility: "unknown",
            viewers: null,
            previous: null,
            tokenErrorCode: code,
            error: code ? null : "サーベイの取得に失敗しました。時間をおいて再度お試しください。",
          });
          return;
        }
        set(bundleToFields(data?.bundle ?? null));
        return;
      }

      const { data, error } = await fetchSafe(() => supabase!.rpc("pulse_my_survey"));
      if (error) {
        set({
          loading: false,
          loaded: true,
          error: missingTableError(error.message) ? MISSING_MSG : error.message,
        });
        return;
      }
      // data === null → 本人特定不可（対象外）。それ以外は {cycle:null} を含む bundle 形。
      set(bundleToFields((data ?? null) as PulseSurveyBundle | null));
    } catch (e) {
      // functions.invoke はネットワーク断で throw する。ここで受けないと
      // loading: true のまま画面が「読み込み中」で固まる。
      set({
        loading: false,
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  /**
   * マイパルス取得（rpc: pulse_my_history）。本人データのみを返す RPC なので
   * 権限ゲートは不要。migration 未適用・対象外社員（戻りが null）の場合は
   * 空配列にして黙って非表示にする — 回答体験を邪魔しないため。
   * 呼び出し側（SurveyPage）が token モードでは呼ばない（決定2＝履歴はログイン必須）。
   */
  loadMyHistory: async () => {
    if (!supabase || get().historyLoading) return;
    set({ historyLoading: true });
    const { data, error } = await fetchSafe(() => supabase!.rpc("pulse_my_history"));
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
    const { cycle, questions, answers, comment, token } = get();
    if (!cycle) return { ok: false, reason: "回答受付中のサーベイがありません" };

    // 送信ペイロード: 入力のある設問のみ（question_id をキーに整形）。
    const payload: PulseAnswerInput[] = questions
      .map((q) => answers[q.id])
      .filter((a): a is PulseAnswerInput => !!a && (a.score != null || !!a.value_text));

    set({ submitting: true });

    if (token) {
      const { data, error } = await supabase.functions.invoke<{
        ok: boolean;
        bundle: PulseSurveyBundle;
      }>("pulse-answer", {
        body: { t: token, action: "submit", answers: payload, comment: comment.trim() || null },
      });
      if (error) {
        const code = await extractPulseAnswerErrorCode(error);
        if (code && TERMINAL_SUBMIT_CODES.has(code)) {
          // token/cycle/対象者そのものが無効になった終端エラー: 再送信しても
          // 直らないため、フォームを畳んで専用の案内画面へ切り替える。
          set({
            submitting: false,
            cycle: null,
            questions: [],
            eligibility: "unknown",
            tokenErrorCode: code,
          });
          return { ok: false, reason: PULSE_ANSWER_ERROR_MESSAGE[code] };
        }
        // submit_failed（RPCのバリデーション例外・詳細は detail）や未知のコード:
        // このサーベイ自体は生きているので、フォームの入力内容は残したまま
        // トーストだけで知らせて再送信できるようにする。
        set({ submitting: false });
        return {
          ok: false,
          reason: code ? PULSE_ANSWER_ERROR_MESSAGE[code] : "送信に失敗しました",
        };
      }
      // 成功レスポンスの bundle で previous・answers を更新する（設計書 §5-2）。
      set(bundleToFields(data?.bundle ?? null));
      set({ submitting: false, submitted: true, alreadyAnswered: true });
      return { ok: true };
    }

    const { error } = await supabase.rpc("pulse_submit_response", {
      p_cycle_id: cycle.id,
      p_answers: payload,
      p_comment: comment.trim() || null,
    });
    if (error) {
      set({ submitting: false });
      return {
        ok: false,
        reason: missingTableError(error.message) ? MISSING_MSG : error.message,
      };
    }
    // previous を更新するため pulse_my_survey を再取得する（設計書 §5-2）。
    await get().loadSurvey();
    // historyLoaded を落として、サンクス画面のマイパルスに今回の回答を反映させる。
    set({ submitting: false, submitted: true, alreadyAnswered: true, historyLoaded: false });
    return { ok: true };
  },
}));
