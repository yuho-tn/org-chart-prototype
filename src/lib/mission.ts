import type { EmployeeRow, PeriodCode } from "./supabase";
import type { PositionLevelRow } from "./profile";
import { levelForPositionTitle } from "./profile";

/**
 * P2: ミッションシート（目標管理・査定連携）第1弾の型とクライアント側
 * 判定ヘルパー。DB 定義は supabase/migrations/0018_mission_sheets.sql。
 *
 * ここでの canWriteAnswerClient / isEvaluatorOfClient はあくまで UI の
 * 活性制御用ミラー — 真の強制は RLS（mission_can_write_answer /
 * is_mission_evaluator_of）が行う。0 行 upsert = サイレント拒否の検出は
 * useMissionsStore 側（useProfilesStore と同型）。
 */

// ── enum / ステージ ──────────────────────────────────────────────────

export type MissionStage =
  | "issued"
  | "goal_submitted"
  | "goal_confirmed"
  | "mid_done"
  | "final_submitted"
  | "assessed";

/** mission_answers.respondent_role（DB enum mission_respondent）。 */
export type MissionRespondent = "self" | "evaluator";

/** 設問の respondent 属性（both = self 行と evaluator 行の両方を持つ）。 */
export type QuestionRespondent = "self" | "evaluator" | "both";

export type QuestionType =
  | "heading"
  | "text"
  | "textarea"
  | "select"
  | "number"
  | "kpi_goal";

export type MissionPhase = "goal" | "mid" | "final";

export type MissionTemplateStatus = "draft" | "published" | "archived";

/** サーバ側 mission_set_stage と同じ順序配列（±1 ステップのみ遷移可）。 */
export const STAGE_ORDER: MissionStage[] = [
  "issued",
  "goal_submitted",
  "goal_confirmed",
  "mid_done",
  "final_submitted",
  "assessed",
];

export const STAGE_LABELS: Record<MissionStage, string> = {
  issued: "発行済",
  goal_submitted: "本人提出済",
  goal_confirmed: "期初確定",
  mid_done: "中間完了",
  final_submitted: "期末提出済",
  assessed: "査定確定",
};

export function stageIndex(stage: MissionStage): number {
  return STAGE_ORDER.indexOf(stage);
}

// ── definition JSONB スキーマ ────────────────────────────────────────

export type MissionQuestion = {
  /** テンプレ内一意の安定 ID（発行後不変）。 */
  id: string;
  label: string;
  type: QuestionType;
  required?: boolean;
  /** 既定 self。 */
  respondent?: QuestionRespondent;
  /** 既定 goal。 */
  phase?: MissionPhase;
  help?: string;
  /** type=select のみ。 */
  choices?: string[];
  /** 任意・配点ウエイト（kpi_goal のみ計算対象。単位=点・合計100想定）。 */
  weight?: number;
  /** アタリマエフラグ（上長評価が✕1つでも→Cを天井にする）。 */
  is_fundamental?: boolean;
  /** 加点評価フラグ（type=number のみ。上長入力点をそのまま合計へ加算）。 */
  is_bonus?: boolean;
};

export type MissionSection = {
  id: string;
  title: string;
  description?: string;
  questions: MissionQuestion[];
};

/** ランク閾値1行（下限含む・上限未満。min の大きい順に判定）。 */
export type RankThreshold = { grade: string; min: number };

/**
 * ランク計算パラメータ（3層分離のパラメータ層）。テンプレ definition.calc
 * に持つ。未指定時はサーバ・クライアントとも DEFAULT_RANK_THRESHOLDS
 * （4期下期 xlsx「等級テーブル評価点設定」の実値）を使う。
 */
export type MissionCalcParams = {
  thresholds?: RankThreshold[];
};

export type MissionDefinition = {
  sections: MissionSection[];
  calc?: MissionCalcParams;
};

/** xlsx 照合済みの既定閾値（D <71 / C 71- / B- 91- / B 101- / B+ 111- / A 121- / A+ 141-）。 */
export const DEFAULT_RANK_THRESHOLDS: RankThreshold[] = [
  { grade: "A+", min: 141 },
  { grade: "A", min: 121 },
  { grade: "B+", min: 111 },
  { grade: "B", min: 101 },
  { grade: "B-", min: 91 },
  { grade: "C", min: 71 },
  { grade: "D", min: 0 },
];

/** calc_mission_rank_v1() の返り値（computed_result にもこの形で凍結される）。 */
export type RankComputedResult = {
  calc_version: number;
  weights_total: number;
  mission_score: number;
  bonus_score: number;
  total: number;
  fundamental_fail: boolean;
  fundamental_fails: string[];
  fundamental_missing: string[];
  missing_inputs: string[];
  rank_before_cap: string;
  rank: string;
  items: {
    question_id: string;
    label: string;
    weight: number;
    achievement_rate: number | null;
    score: number;
  }[];
  bonus_items: { question_id: string; label: string; points: number | null }[];
  assessed_by?: string;
  assessed_at?: string;
};

/** deadlines jsonb: ISO 日付文字列（YYYY-MM-DD）。 */
export type MissionDeadlines = {
  goal?: string;
  mid?: string;
  final?: string;
};

// ── 行型（DB スキーマと一致） ────────────────────────────────────────

export type MissionTemplateRow = {
  id: string;
  period: PeriodCode;
  title: string;
  definition: MissionDefinition;
  deadlines: MissionDeadlines;
  status: MissionTemplateStatus;
  calc_version: number;
  created_at: string;
  updated_at: string;
  updated_by_email: string | null;
};

export type MissionSheetRow = {
  id: string;
  template_id: string;
  employee_number: string;
  period: PeriodCode;
  stage: MissionStage;
  computed_result: Record<string, unknown> | null;
  final_grade: string | null;
  issued_by_email: string | null;
  created_at: string;
  updated_at: string;
};

/** kpi_goal 型設問の value。actual / achievement は第2弾（final phase）。 */
export type KpiGoalValue = {
  title?: string;
  metric?: string;
  target_value?: number | null;
  unit?: string;
  actual_value?: number | null;
  achievement_rate?: number | null;
};

/** text/textarea/select→{text} / number→{number} / kpi_goal→KpiGoalValue */
export type AnswerValue = {
  text?: string;
  number?: number | null;
} & KpiGoalValue;

export type MissionAnswerRow = {
  id: string;
  sheet_id: string;
  question_id: string;
  respondent_role: MissionRespondent;
  value: AnswerValue;
  author_email: string;
  created_at: string;
  updated_at: string;
};

export type MissionStageEventRow = {
  id: string;
  sheet_id: string;
  from_stage: MissionStage | null;
  to_stage: MissionStage;
  actor_email: string;
  reason: string | null;
  created_at: string;
};

// ── definition ヘルパー ──────────────────────────────────────────────

/** jsonb の取りうる null / 不正値を安全な MissionDefinition に正規化。 */
export function normalizeDefinition(raw: unknown): MissionDefinition {
  if (!raw || typeof raw !== "object") return { sections: [] };
  const { sections, calc } = raw as { sections?: unknown; calc?: unknown };
  if (!Array.isArray(sections)) return { sections: [] };
  return {
    sections: sections
      .filter((s): s is MissionSection => !!s && typeof s === "object")
      .map((s) => ({
        ...s,
        questions: Array.isArray(s.questions) ? s.questions : [],
      })),
    ...(calc && typeof calc === "object" ? { calc: calc as MissionCalcParams } : {}),
  };
}

export function questionById(
  def: MissionDefinition,
  questionId: string,
): MissionQuestion | null {
  for (const sec of def.sections) {
    const q = sec.questions.find((x) => x.id === questionId);
    if (q) return q;
  }
  return null;
}

export function questionPhase(q: MissionQuestion): MissionPhase {
  return q.phase ?? "goal";
}

export function questionRespondent(q: MissionQuestion): QuestionRespondent {
  return q.respondent ?? "self";
}

/** answersBySheetId 内の検索キー。 */
export function answerKey(questionId: string, role: MissionRespondent): string {
  return `${questionId}::${role}`;
}

/** 設問タイプごとの「記入済み」判定（required 検証用）。 */
export function isAnswerFilled(
  q: MissionQuestion,
  value: AnswerValue | undefined,
): boolean {
  if (!value) return false;
  switch (q.type) {
    case "number":
      return value.number != null;
    case "kpi_goal":
      return Boolean(value.title?.trim()) || value.target_value != null;
    default:
      return Boolean(value.text?.trim());
  }
}

// ── 権限・活性制御ミラー ─────────────────────────────────────────────

/**
 * サーバ側 is_mission_evaluator_of のクライアントミラー:
 * 同一部署完全一致 AND 自分の position_level が相手より上位。
 * （evaluate_any / manage の OR は呼び出し側で can() と合成する）
 */
export function isEvaluatorOfClient(
  me: EmployeeRow | null | undefined,
  target: EmployeeRow | null | undefined,
  positionLevels: PositionLevelRow[],
): boolean {
  if (!me || !target) return false;
  if (me.employee_number === target.employee_number) return false;
  const dept = me.department?.trim();
  if (!dept || dept !== target.department?.trim()) return false;
  const myLevel = levelForPositionTitle(me.position_title, positionLevels);
  const targetLevel = levelForPositionTitle(target.position_title, positionLevels);
  return myLevel > targetLevel;
}

/**
 * サーバ側 mission_can_write_answer のクライアントミラー（UI 活性制御用）。
 * - role='self': 本人のみ。phase=goal→issued/goal_submitted、mid→goal_confirmed、
 *   final→mid_done で記入可。
 * - role='evaluator': 評価者 or manage。phase=goal→goal_submitted、
 *   mid→goal_confirmed、final→mid_done で記入可。
 * - kpi_goal（phase=goal）のみ両ロールとも mid_done でも記入可（期末の
 *   実績値・達成度の入力窓。目標系フィールドはサーバトリガで凍結）。
 * - heading は回答を持たない。assessed は常に false。
 */
export function canWriteAnswerClient(
  question: MissionQuestion,
  role: MissionRespondent,
  sheet: Pick<MissionSheetRow, "employee_number" | "stage">,
  meNumber: string | null,
  isEvaluator: boolean,
  canManage: boolean,
): boolean {
  if (question.type === "heading") return false;
  if (sheet.stage === "assessed") return false;
  const phase = questionPhase(question);
  const resp = questionRespondent(question);
  const kpiActualWindow =
    question.type === "kpi_goal" && phase === "goal" && sheet.stage === "mid_done";
  if (role === "self") {
    if (resp !== "self" && resp !== "both") return false;
    if (!meNumber || sheet.employee_number !== meNumber) return false;
    if (phase === "goal") {
      return (
        sheet.stage === "issued" ||
        sheet.stage === "goal_submitted" ||
        kpiActualWindow
      );
    }
    if (phase === "mid") return sheet.stage === "goal_confirmed";
    return sheet.stage === "mid_done";
  }
  // role === 'evaluator'
  if (resp !== "evaluator" && resp !== "both") return false;
  if (!isEvaluator && !canManage) return false;
  if (phase === "goal") return sheet.stage === "goal_submitted" || kpiActualWindow;
  if (phase === "mid") return sheet.stage === "goal_confirmed";
  return sheet.stage === "mid_done";
}

/**
 * サーバ側 mission_required_missing(p_kind='final_submit') のクライアント
 * ミラー: 期末提出前の未記入チェック（required な final 設問＋ウエイト付
 * kpi_goal の上長達成度）。返り値は未記入ラベル配列。
 */
export function collectFinalMissing(
  def: MissionDefinition,
  answers: MissionAnswerRow[] | undefined,
): string[] {
  const labels: string[] = [];
  const find = (qid: string, role: MissionRespondent) =>
    answers?.find((a) => a.question_id === qid && a.respondent_role === role) ??
    null;
  for (const sec of def.sections) {
    for (const q of sec.questions) {
      if (q.type === "heading") continue;
      const resp = questionRespondent(q);
      if (q.required && questionPhase(q) === "final") {
        if (
          (resp === "self" || resp === "both") &&
          !isAnswerFilled(q, find(q.id, "self")?.value)
        ) {
          labels.push(`${q.label}（本人）`);
        }
        if (
          (resp === "evaluator" || resp === "both") &&
          !isAnswerFilled(q, find(q.id, "evaluator")?.value)
        ) {
          labels.push(`${q.label}（上長）`);
        }
      }
      if (q.type === "kpi_goal" && (q.weight ?? 0) > 0) {
        const rate = find(q.id, "evaluator")?.value?.achievement_rate;
        if (rate == null) labels.push(`${q.label}（上長の達成度）`);
      }
    }
  }
  return labels;
}

// ── 締切バナー ───────────────────────────────────────────────────────

export type DeadlineInfo = {
  phase: MissionPhase;
  /** 例:「期初目標の提出」 */
  phaseLabel: string;
  /** YYYY-MM-DD */
  date: string;
  /** 期限まであとN日（当日=0、超過は負数）。 */
  daysLeft: number;
  overdue: boolean;
};

const PHASE_LABELS: Record<MissionPhase, string> = {
  goal: "期初目標の提出",
  mid: "中間振り返り",
  final: "期末評価の提出",
};

/** シートの stage から「いま向かっているフェーズ」の締切を返す。 */
export function deadlineInfo(
  template: Pick<MissionTemplateRow, "deadlines">,
  stage: MissionStage,
  now: Date = new Date(),
): DeadlineInfo | null {
  let phase: MissionPhase | null = null;
  if (stage === "issued" || stage === "goal_submitted") phase = "goal";
  else if (stage === "goal_confirmed") phase = "mid";
  else if (stage === "mid_done") phase = "final";
  if (!phase) return null;
  const dateStr = template.deadlines?.[phase];
  if (!dateStr) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  const deadline = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = Math.round(
    (deadline.getTime() - today.getTime()) / 86_400_000,
  );
  return {
    phase,
    phaseLabel: PHASE_LABELS[phase],
    date: dateStr.slice(0, 10),
    daysLeft,
    overdue: daysLeft < 0,
  };
}

// ── 新規テンプレの雛形 definition ────────────────────────────────────

/**
 * 5期上期の初期テンプレ骨子（VISION / CREDO / 6SENSE / 成果の4セクション）。
 * 設問文言は xlsx 未照合のためプレースホルダ — テンプレ編集 UI で仕上げる前提。
 * DB シードにはせず、「新規作成」時のデフォルト definition としてのみ使う。
 */
export const DEFAULT_TEMPLATE_DEFINITION: MissionDefinition = {
  sections: [
    {
      id: "vision",
      title: "VISION / BELIEF",
      description:
        "会社VISIONを踏まえ、あなた自身のVISIONを言語化してください。（プレースホルダ：正式文言はテンプレ編集で差し替え）",
      questions: [
        {
          id: "vision_longterm",
          label: "あなたのVISION【中長期】（2〜3年後の目指す姿）",
          type: "textarea",
          required: true,
          respondent: "self",
          phase: "goal",
          help: "プレースホルダ：中長期で実現したい姿を記入してください。",
        },
        {
          id: "vision_thisterm",
          label: "あなたのVISION【今期】（今期末に到達していたい状態）",
          type: "textarea",
          required: true,
          respondent: "self",
          phase: "goal",
          help: "プレースホルダ：今期の到達状態を記入してください。",
        },
        {
          id: "vision_evaluator_comment",
          label: "VISIONへの上長コメント",
          type: "textarea",
          respondent: "evaluator",
          phase: "goal",
          help: "プレースホルダ：期初面談での上長コメントを記入してください。",
        },
      ],
    },
    {
      id: "credo",
      title: "CREDO",
      description:
        "CREDOを体現するための行動目標を設定してください。（プレースホルダ）",
      questions: [
        {
          id: "credo_action",
          label: "CREDO体現の行動目標",
          type: "textarea",
          required: true,
          respondent: "self",
          phase: "goal",
          help: "プレースホルダ：日々の行動レベルに落とした目標を記入してください。",
        },
        {
          id: "credo_evaluator_comment",
          label: "CREDO行動目標への上長コメント",
          type: "textarea",
          respondent: "evaluator",
          phase: "goal",
        },
      ],
    },
    {
      id: "sixsense",
      title: "6SENSE",
      description:
        "6SENSEのうち今期特に磨く力と、その伸ばし方を設定してください。（プレースホルダ）",
      questions: [
        {
          id: "sixsense_focus",
          label: "今期フォーカスする6SENSE",
          type: "text",
          required: true,
          respondent: "self",
          phase: "goal",
          help: "プレースホルダ：注力する SENSE 名を記入してください。",
        },
        {
          id: "sixsense_plan",
          label: "伸ばすための具体アクション",
          type: "textarea",
          required: true,
          respondent: "self",
          phase: "goal",
        },
        {
          id: "sixsense_evaluator_comment",
          label: "6SENSEへの上長コメント",
          type: "textarea",
          respondent: "evaluator",
          phase: "goal",
        },
      ],
    },
    {
      id: "results",
      title: "成果（KPI目標）",
      description:
        "今期の成果目標をKPIとして設定してください。数値・単位まで具体化します。（プレースホルダ）",
      questions: [
        {
          id: "kpi_goal_1",
          label: "KPI目標 1",
          type: "kpi_goal",
          required: true,
          respondent: "both",
          phase: "goal",
          weight: 10,
        },
        {
          id: "kpi_goal_2",
          label: "KPI目標 2",
          type: "kpi_goal",
          respondent: "both",
          phase: "goal",
          weight: 10,
        },
        {
          id: "kpi_goal_3",
          label: "KPI目標 3",
          type: "kpi_goal",
          respondent: "both",
          phase: "goal",
          weight: 10,
        },
      ],
    },
    {
      id: "midterm",
      title: "中間振り返り",
      description:
        "期の折り返しでの進捗・課題・後半のアクションを整理します（中間面談で使用）。",
      questions: [
        {
          id: "mid_self_review",
          label: "進捗と後半のアクション（本人）",
          type: "textarea",
          respondent: "self",
          phase: "mid",
        },
        {
          id: "mid_evaluator_comment",
          label: "中間面談での上長コメント",
          type: "textarea",
          respondent: "evaluator",
          phase: "mid",
        },
      ],
    },
    {
      id: "fundamental",
      title: "アタリマエ評価",
      description:
        "社会人・SHO-SANメンバーとしてのアタリマエ基準。上長評価で✕が1つでもあるとランクはCが上限になります（期末に○/×で評価）。",
      questions: [
        {
          id: "fund_punctual",
          label: "遅刻数（前日までの報告以外の遅刻が半期3回以下・例外なし）",
          type: "select",
          choices: ["○", "×"],
          respondent: "both",
          phase: "final",
          is_fundamental: true,
        },
        {
          id: "fund_attitude",
          label: "勤務態度",
          type: "select",
          choices: ["○", "×"],
          respondent: "both",
          phase: "final",
          is_fundamental: true,
        },
        {
          id: "fund_hourensou",
          label: "報連相",
          type: "select",
          choices: ["○", "×"],
          respondent: "both",
          phase: "final",
          is_fundamental: true,
        },
        {
          id: "fund_rules",
          label: "ルール遵守",
          type: "select",
          choices: ["○", "×"],
          respondent: "both",
          phase: "final",
          is_fundamental: true,
        },
        {
          id: "fund_ai_media",
          label: "AI情報局の視聴（毎月参加or録画視聴＋出席クイズ期限内正解）",
          type: "select",
          choices: ["○", "×"],
          respondent: "both",
          phase: "final",
          is_fundamental: true,
        },
      ],
    },
    {
      id: "bonus",
      title: "加点評価",
      description:
        "ミッション外の会社貢献・チャレンジへの加点（上長が点数を手入力。目安1件3点）。",
      questions: [
        {
          id: "bonus_points",
          label: "加点（点）",
          type: "number",
          respondent: "evaluator",
          phase: "final",
          is_bonus: true,
          help: "加点対象の取り組みと点数の根拠は上長コメントに記載してください。",
        },
        {
          id: "bonus_comment",
          label: "加点理由・期末総評（上長コメント）",
          type: "textarea",
          respondent: "evaluator",
          phase: "final",
        },
        {
          id: "final_self_review",
          label: "期末の自己振り返り",
          type: "textarea",
          respondent: "self",
          phase: "final",
        },
      ],
    },
  ],
  calc: { thresholds: DEFAULT_RANK_THRESHOLDS },
};

/** periods テーブルが読めない場合（RLS で payroll 管理者限定）のフォールバック。 */
export const FALLBACK_PERIOD_CODES: PeriodCode[] = [
  "1H1", "1H2", "2H1", "2H2", "3H1", "3H2", "4H1", "4H2", "5H1",
];
