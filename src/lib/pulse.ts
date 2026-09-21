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
  | "submit_failed"
  | "token_secret_not_configured";

/** トークン回答画面のエラーコード → 日本語の案内文（設計書 §5-3）。 */
export const PULSE_ANSWER_ERROR_MESSAGE: Record<PulseAnswerErrorCode, string> = {
  invalid_token: "このリンクは無効です。",
  expired: "このリンクは期限切れです（締切を過ぎています）。",
  closed: "この月の受付は終了しました。",
  not_target: "回答対象として登録されていません。",
  not_found: "対象のサーベイが見つかりません。",
  submit_failed: "送信に失敗しました。",
  token_secret_not_configured: "回答リンクの設定が完了していません（管理者に連絡してください）。",
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

// ── P2: アラート一覧＋対応管理（設計書 §10） ─────────────────────────

/**
 * アラート種別。P2以降は pulse_alert_rules.code と同じ文字列（例: geppo_stormy・
 * comment_sos）が入る（設計書 §10-1・`pulse_alerts.type` の check は drop 済み）。
 * 移行前データは旧値 "absolute" | "delta" | "custom" の可能性がある（ALERT_TYPE_LABEL
 * にフォールバック定義を残す）。
 */
export type PulseAlertType = string;
export type PulseAlertStatus = "open" | "closed";
export type PulseActionState = "todo" | "doing" | "done" | "not_needed" | "on_hold_org";
export type PulseAlertSource = "score" | "behavior" | "comment";
export type PulseAlertSeverity = "info" | "warn" | "critical";

/** pulse_alert_actions（1アラート=1件・対応管理ループ・設計書 §10-5）。 */
export type PulseAlertAction = {
  id: string;
  title: string | null;
  assignee_employee_number: string | null;
  assignee_name: string | null;
  state: PulseActionState;
  due_date: string | null;
  note: string | null;
  updated_at: string;
};

/** rpc('pulse_list_alerts') の1行（設計書 §10-5）。subject_name は実名非公開なら null。
 *  comment_categories/comment_summary は人事（realname権限）以外は null。 */
export type PulseAlertRow = {
  alert_id: string;
  employee_number: string;
  subject_name: string | null;
  subject_department: string | null;
  type: PulseAlertType;
  reason: Record<string, unknown>;
  status: PulseAlertStatus;
  created_at: string;
  period: string;
  rule_code: string;
  rule_label: string;
  source: PulseAlertSource;
  categories: string[];
  severity: PulseAlertSeverity;
  disclose_to_manager: boolean;
  notified_at: string | null;
  comment_categories: string[] | null;
  comment_summary: string | null;
  sum_score: number | null;
  prev_sum_score: number | null;
  action: PulseAlertAction | null;
};

/** 旧 type（absolute/delta/custom）の表示ラベル。新データは ALERT_RULE_LABEL を先に見る。 */
export const ALERT_TYPE_LABEL: Record<string, string> = {
  absolute: "低スコア（旧）",
  delta: "急降下（旧）",
  custom: "個別",
};

export const ACTION_STATE_LABEL: Record<PulseActionState, string> = {
  todo: "未対応",
  doing: "対応中",
  done: "対応済",
  not_needed: "対応不要",
  on_hold_org: "保留(組織課題)",
};

/** 対応状況フィルタ・内訳バーの表示順（進行度の低い順）。 */
export const ACTION_STATE_ORDER: PulseActionState[] = [
  "todo",
  "doing",
  "on_hold_org",
  "done",
  "not_needed",
];

export const ALERT_SEVERITY_LABEL: Record<PulseAlertSeverity, string> = {
  critical: "重大",
  warn: "警告",
  info: "情報",
};

export const ALERT_SOURCE_LABEL: Record<PulseAlertSource, string> = {
  score: "スコア",
  behavior: "行動",
  comment: "コメント",
};

/** pulse_alert_rules.code → label（設計書 §10-1）。未知 code はそのまま表示（呼び出しは alertRuleLabel() 経由）。 */
export const ALERT_RULE_LABEL: Record<string, string> = {
  geppo_stormy: "荒天がある",
  geppo_drop2: "2段階下落して雨以下",
  geppo_rain2: "雨以下が2項目",
  preset_all_cloudy: "全項目くもり",
  preset_decline_3m: "3か月連続下降",
  preset_same_3m: "3か月同回答",
  preset_org_change: "主務組織の変更",
  preset_unanswered_3m: "3か月未回答",
  legacy_absolute: "総合平均が低い（旧）",
  legacy_delta: "総合平均の急降下（旧）",
  comment_sos: "SOS（自由記述）",
  comment_health: "体調不安（自由記述）",
  comment_relationship: "人間関係（自由記述）",
  comment_org: "組織課題（自由記述）",
  comment_evaluation: "評価（自由記述）",
  comment_work: "仕事（自由記述）",
  comment_career: "キャリア（自由記述）",
  comment_private: "プライベート（自由記述）",
  comment_admin: "総務（自由記述）",
  comment_request: "要望・提言（自由記述）",
  comment_unclassified: "分類困難（自由記述）",
};

/** ルールラベルの安全な解決（code→label。未知 code は code をそのまま返す）。 */
export function alertRuleLabel(code: string): string {
  return ALERT_RULE_LABEL[code] ?? code;
}

/**
 * pulse_alerts.type（P2以降は rule_code と同義）のラベル解決。新ルール表 → 旧
 * ALERT_TYPE_LABEL（absolute/delta/custom）→ type文字列そのまま、の順でフォールバックする
 * （設計書 §10-8「#/pulse/members/:num のCareTimelineは新typeのラベルを表示できること」）。
 */
export function alertTypeLabel(type: string): string {
  return ALERT_RULE_LABEL[type] ?? ALERT_TYPE_LABEL[type] ?? type;
}

function fmtNum(v: unknown): string {
  return typeof v === "number" ? v.toFixed(2) : v == null ? "—" : String(v);
}

/** ["2026-09","2026-10","2026-11"] → "2026-09〜11"（年跨ぎは "2026-12〜2027-02"）。1件なら period単体。 */
function periodsRangeLabel(periods: string[]): string {
  const sorted = [...periods].filter(Boolean).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return periods.join("・");
  if (first === last) return first;
  const [fy] = first.split("-");
  const [ly, lm] = last.split("-");
  return fy === ly ? `${first}〜${lm}` : `${first}〜${ly}-${lm}`;
}

/** score(1..5) を天気ラベルへ（非数値・範囲外は数値そのまま文字列化）。 */
function weatherLabelOf(score: unknown): string {
  if (typeof score !== "number") return fmtNum(score);
  const w = weatherForScore(score);
  return w ? w.label : fmtNum(score);
}

/**
 * アラートの reason jsonb を人間可読な1行に整形（設計書 §10-2）。ルール別に reason の
 * 形が異なるため code で分岐する。未知の code・欠損フィールドは静かにフォールバックする
 * （reason.rule 文字列 → alertRuleLabel(code) → "個別アラート"）。
 */
export function alertReasonSummary(code: string, reason: Record<string, unknown>): string {
  const items = Array.isArray(reason.items) ? (reason.items as Record<string, unknown>[]) : [];

  switch (code) {
    case "geppo_stormy":
      return items.length > 0
        ? items.map((it) => `${String(it.category ?? "—")}＝${weatherLabelOf(it.score)}`).join("・")
        : "荒天の項目があります";

    case "geppo_drop2":
      return items.length > 0
        ? items
            .map((it) => `${String(it.category ?? "—")} ${fmtNum(it.prev)}→${fmtNum(it.cur)}`)
            .join("・")
        : "2段階下落して雨以下の項目があります";

    case "geppo_rain2":
      return items.length > 0
        ? items.map((it) => `${String(it.category ?? "—")}＝${weatherLabelOf(it.score)}`).join("・")
        : "雨以下の項目が複数あります";

    case "preset_all_cloudy":
      return "天気4項目すべて「くもり」でした";

    case "preset_decline_3m": {
      const series = Array.isArray(reason.series) ? (reason.series as Record<string, unknown>[]) : [];
      return series.length > 0
        ? `総合 ${series.map((s) => fmtNum(s.overall)).join("→")}`
        : "3か月連続で下降しています";
    }

    case "preset_same_3m": {
      const periods = Array.isArray(reason.periods) ? (reason.periods as string[]) : [];
      return periods.length >= 2 ? `3か月同じ回答（${periodsRangeLabel(periods)}）` : "3か月同じ回答";
    }

    case "preset_org_change": {
      const prev = typeof reason.prev_department === "string" ? reason.prev_department : "—";
      const cur = typeof reason.department === "string" ? reason.department : "—";
      return `${prev} → ${cur}`;
    }

    case "preset_unanswered_3m": {
      const periods = Array.isArray(reason.periods) ? (reason.periods as string[]) : [];
      return periods.length > 0 ? `${periodsRangeLabel(periods)} 未回答` : "3か月未回答です";
    }

    // 旧ルール（legacy_absolute/legacy_delta は現行 seed のOFF行・absolute/delta は移行前データ）
    case "legacy_absolute":
    case "absolute":
      return `平均総合 ${fmtNum(reason.overall)}（閾値 ${fmtNum(reason.threshold)} 以下）`;
    case "legacy_delta":
    case "delta":
      return `前回比 ${fmtNum(reason.delta)}（${fmtNum(reason.prev_overall)} → ${fmtNum(reason.overall)}）`;

    default: {
      if (code.startsWith("comment_")) {
        if (typeof reason.summary === "string" && reason.summary.trim() !== "") return reason.summary;
        if (typeof reason.category === "string") return `コメント分類：${reason.category}`;
        return "コメントに気になる内容があります";
      }
      if (typeof reason.rule === "string" && reason.rule) return reason.rule;
      return code ? alertRuleLabel(code) : "個別アラート";
    }
  }
}

// ── P2: アラートルール管理（設計書 §10-1・#/pulse/admin） ────────────

/** アラートルール管理画面の params 数値入力欄（code→編集可能キー）。無ければ数値paramsなし（comment_*等）。 */
export const ALERT_RULE_PARAM_FIELDS: Record<string, { key: string; label: string }[]> = {
  geppo_stormy: [{ key: "threshold", label: "しきい値（この値以下で該当）" }],
  geppo_drop2: [
    { key: "drop", label: "下落幅（この値以上で該当）" },
    { key: "max_after", label: "下落後スコア（この値以下で該当）" },
  ],
  geppo_rain2: [
    { key: "threshold", label: "しきい値（この値以下を対象に数える）" },
    { key: "min_items", label: "該当項目数（この値以上で該当）" },
  ],
  preset_all_cloudy: [{ key: "score", label: "対象スコア" }],
  preset_decline_3m: [{ key: "months", label: "対象月数" }],
  preset_same_3m: [{ key: "months", label: "対象月数" }],
  preset_unanswered_3m: [{ key: "months", label: "対象月数" }],
  legacy_absolute: [{ key: "threshold", label: "しきい値（この値以下で該当）" }],
  legacy_delta: [{ key: "drop", label: "下落幅（この値以上で該当）" }],
};

/** public.pulse_alert_rules の1行（設計書 §10-1）。 */
export type PulseAlertRule = {
  id: string;
  code: string;
  label: string;
  description: string | null;
  source: PulseAlertSource;
  params: Record<string, number | string>;
  is_active: boolean;
  notify_immediately: boolean;
  disclose_to_manager: boolean;
  sort_order: number;
};

// ── P2: アラート KPI・振り返り（設計書 §10-7） ────────────────────────

/** rpc('pulse_alert_kpis') の戻り。権限が無ければ RPC は null を返す（呼び出し側で扱う）。 */
export type PulseAlertKpis = {
  alerted_employees: number;
  open_total: number;
  my_open: number;
  by_state: Record<PulseActionState, number>;
  trend: { period: string; alerted_employees: number }[];
};

/** rpc('pulse_alert_review') の1行。name は実名閲覧権が無ければ null。 */
export type PulseAlertReviewRow = {
  employee_number: string;
  name: string | null;
  department: string | null;
  alert_types: string[];
  base_period: string;
  base_sum: number | null;
  latest_period: string | null;
  latest_sum: number | null;
  delta: number | null;
  series: { period: string; sum: number | null }[];
  action_state: PulseActionState | null;
  action_title: string | null;
};

/** pulse_settings のアラート通知欄（設計書 §10-6・#/pulse/admin「アラート通知」）。 */
export type PulseAlertNotifySettings = {
  alert_digest_recipients: string[];
  alert_digest_enabled: boolean;
  alert_immediate_enabled: boolean;
};

// ── スライス5: コメント一覧 ───────────────────────────────────────

/** rpc('pulse_list_comments') の1行。author_name は匿名なら null。 */
export type PulseCommentRow = {
  response_id: string;
  author_name: string | null;
  department: string | null;
  comment: string;
  answered_at: string | null;
};

/** pulse_comment_classifications の11分類（固定順・設計書 §10-4）。 */
export const COMMENT_CATEGORIES: readonly string[] = [
  "SOS",
  "体調不安",
  "人間関係",
  "仕事",
  "評価",
  "キャリア",
  "プライベート",
  "総務",
  "要望/提言",
  "組織課題",
  "分類困難",
] as const;

/** pulse_comment_classifications の1行（response_id で直読・設計書 §10-8）。RLSで人事以外は0行。 */
export type PulseCommentClassification = {
  response_id: string;
  categories: string[];
  primary_category: string | null;
  severity: "low" | "mid" | "high" | null;
  summary: string | null;
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
