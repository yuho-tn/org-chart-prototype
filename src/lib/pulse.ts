// パルスサーベイのクライアント型とヘルパー。DB スキーマは
// supabase/migrations/0021_pulse_survey.sql / 0022_pulse_my_response.sql。

export type PulseQuestionType = "weather5" | "scale" | "free_text";

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
