// パルスサーベイのクライアント型とヘルパー。DB スキーマは
// supabase/migrations/0021_pulse_survey.sql / 0022_pulse_my_response.sql。

export type PulseQuestionType = "weather5" | "scale" | "free_text" | "nps";

export const QUESTION_TYPE_LABEL: Record<PulseQuestionType, string> = {
  weather5: "天気5段階",
  scale: "数値スケール",
  free_text: "自由記述",
  nps: "eNPS（0〜10）",
};

export const SET_STATUS_LABEL: Record<string, string> = {
  draft: "下書き",
  active: "有効",
  archived: "アーカイブ",
};

export const CYCLE_STATUS_LABEL: Record<string, string> = {
  scheduled: "予定",
  sent: "受付中",
  closed: "終了",
};

/** public.pulse_question_sets */
export type PulseQuestionSetRow = {
  id: string;
  name: string;
  version: number;
  status: "draft" | "active" | "archived";
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  updated_by_email: string | null;
};

/** public.pulse_questions */
export type PulseQuestionRow = {
  id: string;
  question_set_id: string;
  sort_order: number;
  label: string;
  category: string | null;
  type: PulseQuestionType;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** public.pulse_cycles */
export type PulseCycleRow = {
  id: string;
  period: string; // YYYY-MM
  question_set_id: string;
  send_date: string | null;
  due_date: string | null;
  status: "scheduled" | "sent" | "closed";
  created_at: string;
  updated_at: string;
};

/** public.pulse_responses */
export type PulseResponseRow = {
  id: string;
  cycle_id: string;
  employee_number: string;
  source: "native" | "geppo_import";
  answered_at: string | null;
  comment: string | null;
  snap_department: string | null;
  snap_employment_type: string | null;
  snap_position_title: string | null;
  created_at: string;
  updated_at: string;
};

/** 1 設問への回答（送信ペイロード / プレフィル共通）。 */
export type PulseAnswerInput = {
  question_id: string;
  score: number | null;
  value_text: string | null;
};

/** rpc('pulse_my_response') の戻り。対象外社員は null。 */
export type PulseMyResponse = {
  employee_number: string;
  response: PulseResponseRow | null;
  answers: PulseAnswerInput[];
};

// ── v3 P1: 回答 bundle（トークン経路とログイン経路で共通の形・設計書 §3-4） ──

/** bundle.cycle（pulse_cycles の一部）。 */
export type PulseSurveyBundleCycle = {
  id: string;
  period: string;
  send_date: string | null;
  due_date: string | null;
  status: PulseCycleRow["status"];
};

/** bundle.questions の1件（PulseQuestionRow から is_active/タイムスタンプを除いた回答者向けの形）。 */
export type PulseSurveyBundleQuestion = {
  id: string;
  sort_order: number;
  label: string;
  category: string | null;
  type: PulseQuestionType;
};

/** bundle.response（本人の回答が既にあれば）。 */
export type PulseSurveyBundleResponse = {
  id: string;
  answered_at: string | null;
  comment: string | null;
  updated_at: string;
};

/** bundle.viewers（決定1＝閲覧者の明示。回答画面冒頭に出す）。 */
export type PulseSurveyViewers = {
  notice: string;
  manager_disclosure: boolean;
  manager_names: string[];
};

/** bundle.previous（前回との比較用・カテゴリ別平均＋eNPS）。 */
export type PulseSurveyPrevious = {
  period: string;
  by_category: Record<string, number>;
  nps: number | null;
  answered_at: string | null;
};

/**
 * rpc('pulse_my_survey') / rpc('pulse_survey_bundle_for')（Edge Function `pulse-answer`
 * 経由）が返す回答フォーム一式（設計書 §3-4）。受付中サイクルが無い場合は `{ cycle: null }`
 * のみを持つ最小形で返るため、`cycle` 以外は任意（optional）にしている。
 */
export type PulseSurveyBundle = {
  employee_number?: string;
  display_name?: string;
  is_target?: boolean;
  cycle: PulseSurveyBundleCycle | null;
  questions?: PulseSurveyBundleQuestion[];
  response?: PulseSurveyBundleResponse | null;
  answers?: PulseAnswerInput[];
  viewers?: PulseSurveyViewers;
  previous?: PulseSurveyPrevious | null;
};

/** Edge Function `pulse-answer` が非2xxで返すエラーコード（設計書 §4-2）。 */
export type PulseAnswerErrorCode =
  | "invalid_token"
  | "expired"
  | "closed"
  | "not_target"
  | "not_found"
  | "submit_failed";

/** トークン回答画面のエラーコード → 日本語の案内文（設計書 §5-3）。 */
export const PULSE_ANSWER_ERROR_MESSAGE: Record<PulseAnswerErrorCode, string> = {
  invalid_token: "このリンクは無効です。",
  expired: "このリンクは期限切れです（締切を過ぎています）。",
  closed: "この月の受付は終了しました。",
  not_target: "回答対象として登録されていません。",
  not_found: "対象のサーベイが見つかりません。",
  submit_failed: "送信に失敗しました。",
};

/** 天気5段階（score 5=快晴 … 1=荒天）。絵文字＋短ラベル。 */
export const WEATHER_SCALE: { score: number; emoji: string; label: string }[] = [
  { score: 5, emoji: "☀️", label: "快晴" },
  { score: 4, emoji: "🌤️", label: "晴れ" },
  { score: 3, emoji: "☁️", label: "くもり" },
  { score: 2, emoji: "🌧️", label: "雨" },
  { score: 1, emoji: "⛈️", label: "荒天" },
];

/** public.pulse_monthly_aggregates の metrics jsonb（dimension で内容が変わる）。 */
export type PulseMetrics = {
  n: number;
  masked: boolean;
  avg_overall?: number;
  // eNPS（0030 で付与・nps 回答が1件以上ある dimension のみ）
  enps_n?: number;
  enps_masked?: boolean;
  enps?: number; // 推奨者% − 批判者%（-100..100）
  promoter_rate?: number;
  detractor_rate?: number;
  // total 行のみ（0023 で付与）
  target?: number;
  response_rate?: number | null;
  weather_dist?: Record<string, number>; // {"1".."5": 件数}
  by_category?: Record<string, { avg: number; n: number }>;
};

/** public.pulse_monthly_aggregates の1行。 */
export type PulseAggregateRow = {
  id: string;
  period: string;
  dimension: "total" | "department" | "employment_type" | "position_title";
  dimension_key: string;
  metrics: PulseMetrics;
  created_at: string;
};

export const DIMENSION_LABEL: Record<string, string> = {
  total: "全社",
  department: "部署別",
  employment_type: "雇用形態別",
  position_title: "役職別",
};

/** YYYY-MM → "2026年7月"。 */
export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  return `${m[1]}年${Number(m[2])}月`;
}

/** "YYYY-MM" → "26/7"（グラフ・グリッドの軸ラベル用の短縮表記）。 */
export function periodShort(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${m[1].slice(2)}/${Number(m[2])}` : period;
}

// ── スライス4: アラート一覧＋対応管理 ─────────────────────────────

export type PulseAlertType = "absolute" | "delta" | "custom";
export type PulseAlertStatus = "open" | "closed";
export type PulseActionState = "todo" | "doing" | "done";

/** pulse_alert_actions（1アラート=1件・対応管理ループ）。 */
export type PulseAlertAction = {
  id: string;
  assignee_employee_number: string | null;
  assignee_name: string | null;
  state: PulseActionState;
  due_date: string | null;
  note: string | null;
  updated_at: string;
};

/** rpc('pulse_list_alerts') の1行。subject_name は実名非公開なら null。 */
export type PulseAlertRow = {
  alert_id: string;
  employee_number: string;
  subject_name: string | null;
  subject_department: string | null;
  type: PulseAlertType;
  reason: Record<string, unknown>;
  status: PulseAlertStatus;
  created_at: string;
  action: PulseAlertAction | null;
};

export const ALERT_TYPE_LABEL: Record<PulseAlertType, string> = {
  absolute: "低スコア",
  delta: "急降下",
  custom: "個別",
};

export const ACTION_STATE_LABEL: Record<PulseActionState, string> = {
  todo: "未着手",
  doing: "対応中",
  done: "完了",
};

function fmtNum(v: unknown): string {
  return typeof v === "number" ? v.toFixed(2) : v == null ? "—" : String(v);
}

/** アラートの reason jsonb を人間可読な1行に整形。 */
export function alertReasonSummary(type: PulseAlertType, reason: Record<string, unknown>): string {
  if (type === "absolute") {
    return `平均総合 ${fmtNum(reason.overall)}（閾値 ${fmtNum(reason.threshold)} 以下）`;
  }
  if (type === "delta") {
    return `前回比 ${fmtNum(reason.delta)}（${fmtNum(reason.prev_overall)} → ${fmtNum(reason.overall)}）`;
  }
  return typeof reason.rule === "string" ? reason.rule : "個別アラート";
}

// ── スライス5: コメント一覧 ───────────────────────────────────────

/** rpc('pulse_list_comments') の1行。author_name は匿名なら null。 */
export type PulseCommentRow = {
  response_id: string;
  author_name: string | null;
  department: string | null;
  comment: string;
  answered_at: string | null;
};

// ── P4-①: 個人別回答推移（実名閲覧権者のみ） ─────────────────────

/** history の1点（migration 0029）。overall は 5点満点・nps除外。 */
export type PulseHistoryPoint = {
  period: string;
  overall: number | null;
  answered_at: string | null;
};

/** rpc('pulse_list_member_summaries') の1行。 */
export type PulseMemberSummary = {
  employee_number: string;
  name: string;
  department: string | null;
  position_title: string | null;
  history: PulseHistoryPoint[]; // 直近6サイクル・古→新
};

/** rpc('pulse_person_history') の1行（古→新）。 */
export type PulsePersonHistoryRow = {
  period: string;
  cycle_id: string;
  overall: number | null;
  by_category: Record<string, number>;
  comment: string | null;
  answered_at: string | null;
};

// ── P4-③: 人起点の対応・面談ログ ─────────────────────────────────

export type PulseCareKind = "interview" | "outreach" | "other";

export const CARE_KIND_LABEL: Record<PulseCareKind, string> = {
  interview: "面談",
  outreach: "声かけ",
  other: "その他",
};

/** rpc('pulse_list_care_logs') の1行（新→旧）。 */
export type PulseCareLogRow = {
  id: string;
  kind: PulseCareKind;
  note: string;
  author_email: string;
  author_name: string | null;
  created_at: string;
};

/** rpc('pulse_person_alerts') の1行（新→旧）。 */
export type PulsePersonAlertRow = {
  alert_id: string;
  period: string;
  type: PulseAlertType;
  reason: Record<string, unknown>;
  status: PulseAlertStatus;
  created_at: string;
  action: PulseAlertAction | null;
};

/** スコア(1..5)に最も近い天気段階を返す。null は undefined。 */
export function weatherForScore(score: number | null | undefined) {
  if (score == null) return undefined;
  const rounded = Math.min(5, Math.max(1, Math.round(score)));
  return WEATHER_SCALE.find((w) => w.score === rounded);
}

export type PulseTrend = "up" | "down" | "flat" | "none";

/** 直近2点の比較でトレンド矢印を出す（0.05未満の差はflat扱い）。 */
export function memberTrend(history: PulseHistoryPoint[]): PulseTrend {
  const pts = history.filter((h) => h.overall != null);
  if (pts.length < 2) return "none";
  const prev = pts[pts.length - 2].overall as number;
  const last = pts[pts.length - 1].overall as number;
  if (last - prev > 0.05) return "up";
  if (prev - last > 0.05) return "down";
  return "flat";
}

/** "YYYY-MM" → 通算月数（隣接判定用）。不正形式は null。 */
function monthIndex(period: string): number | null {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return null;
  return Number(m[1]) * 12 + Number(m[2]);
}

/**
 * 「3ヶ月連続下降」フラグ: 直近3回答が暦月で連続しており、かつ単調に
 * 下降している（p[-3] > p[-2] > p[-1]）。回答が3点未満・月が飛んでいる
 * （未回答月を挟む）場合は false。
 */
export function isConsecutiveDecline(history: PulseHistoryPoint[]): boolean {
  const pts = history.filter((h) => h.overall != null);
  if (pts.length < 3) return false;
  const [a, b, c] = pts.slice(-3);
  const ma = monthIndex(a.period);
  const mb = monthIndex(b.period);
  const mc = monthIndex(c.period);
  if (ma == null || mb == null || mc == null) return false;
  if (mb - ma !== 1 || mc - mb !== 1) return false;
  return (a.overall as number) > (b.overall as number) && (b.overall as number) > (c.overall as number);
}
