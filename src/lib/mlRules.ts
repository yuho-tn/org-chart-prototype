/**
 * ML規定（マネージャー・リーダー規定）の表示コンテンツ。
 *
 * 出典：Notion「🥎 ML規定」https://app.notion.com/p/1b67a40973ec804c809cfe8dceec74be
 * 2026-08-05 の権限組織図MTG（小澤・森岡・丹野）で「表はあるが多くの人が見ていない・
 * 分かっていない」という課題が挙がり、TalentHub の体制図タブに載せることになった。
 *
 * ── 原表からのブラッシュアップ方針 ────────────────────────────────
 *  1. 17行のフラットな表を、意味のまとまり（勤怠・労務／決裁・金額／人事・組織／
 *     経営・計画／評価・報酬）の5セクションに再編。原表の行と値は落とさない。
 *  2. 誤記を修正：「1000万位内」→「1000万円以内」、「決済」→「決裁」。
 *  3. 「ー」＝権限なし（該当なし）であることを凡例で明示。
 *  4. CEO列の空欄のうち、金額・計画に関わる4行は「上限なし（全社決裁）」と補完し、
 *     補完したセルには印を付けて表下に注記する（2026-08-05 丹野さん承認）。
 *     原表が空欄のままだと「CEOには権限がない」と読めてしまうため。
 *     補完でないセル（打刻管理の役員列など）は「—＝該当なし」のまま。
 *  5. 評価者（ミッション面談）の4行は「誰を評価するか」の軸が他の行と違うので、
 *     被評価者×一次／二次の専用マトリクスとして切り出す。
 *
 * 制度改定時はこのファイルだけを差し替える（reviewsContent.ts と同じ運用）。
 */

export type MlRoleColumn = {
  code: string;
  /** 正式名称（ヘッダーの2行目に小さく出す） */
  name: string;
};

export const ML_ROLES: MlRoleColumn[] = [
  { code: "CEO", name: "最高経営責任者" },
  { code: "COO", name: "最高執行責任者" },
  { code: "CTO・CRO", name: "技術／営業統括役員" },
  { code: "DM", name: "Divisionマネージャー" },
  { code: "TM", name: "Teamマネージャー" },
  { code: "L", name: "リーダー" },
];

/**
 * セルの表示種別。
 *  - `has`  : 権限・役割がある（通常表示）
 *  - `none` : 権限なし／該当なし（原表の「ー」および空欄）
 *  - `limit`: 金額上限つきの決裁権（強調表示）
 */
export type MlCellTone = "has" | "none" | "limit";

export type MlCell = {
  text: string;
  /** 条件・前提（セル内の小さい行） */
  note?: string;
  tone?: MlCellTone;
  /** 原表が空欄で、運用実態に合わせて補完したセル（表下に注記を出す） */
  supplemented?: boolean;
};

export type MlRow = {
  label: string;
  /** 行の補足（原表の「※インターンは別」等） */
  sublabel?: string;
  /** ML_ROLES と同じ並び・同じ長さ */
  cells: MlCell[];
};

export type MlSection = {
  id: string;
  title: string;
  description: string;
  rows: MlRow[];
};

const NONE: MlCell = { text: "—", tone: "none" };

export const ML_SECTIONS: MlSection[] = [
  {
    id: "attendance",
    title: "勤怠・労務",
    description:
      "日々の勤怠は「1つ下のレイヤーを見る」が原則。TMがメンバーを、DMがTMを管理する。",
    rows: [
      {
        label: "打刻管理",
        cells: [
          NONE,
          NONE,
          NONE,
          { text: "TMの勤怠管理", tone: "has" },
          { text: "メンバーの勤怠管理", tone: "has" },
          NONE,
        ],
      },
      {
        label: "早退・遅刻・欠勤",
        cells: [
          { text: "執行役員を管理", tone: "has" },
          { text: "DMを管理", tone: "has" },
          { text: "DMを管理", tone: "has" },
          { text: "TMを管理", tone: "has" },
          { text: "メンバーを管理", tone: "has" },
          { text: "報告対象", note: "承認権はなく、報告を受ける立場", tone: "has" },
        ],
      },
      {
        label: "残業・休日出勤・有給申請",
        cells: [
          { text: "執行役員を管理", tone: "has" },
          { text: "DMを管理", tone: "has" },
          { text: "DMを管理", tone: "has" },
          { text: "TMを管理", tone: "has" },
          { text: "メンバーを管理", tone: "has" },
          { text: "報告対象", note: "承認権はなく、報告を受ける立場", tone: "has" },
        ],
      },
    ],
  },
  {
    id: "budget",
    title: "決裁・金額",
    description:
      "金額の決裁権はレイヤーごとに上限が決まっている。上限を超える支出は必ず上位レイヤーへ上げる。",
    rows: [
      {
        label: "決裁権",
        cells: [
          { text: "上限なし（全社決裁）", tone: "limit", supplemented: true },
          {
            text: "半期で1,000万円以内",
            note: "全社PL目標の達成が前提",
            tone: "limit",
          },
          {
            text: "半期で100万円以内",
            note: "Division PL目標の達成が前提",
            tone: "limit",
          },
          {
            text: "半期で100万円以内",
            note: "Division PL目標の達成が前提",
            tone: "limit",
          },
          NONE,
          NONE,
        ],
      },
      {
        label: "経費申請",
        cells: [
          { text: "二次承認", tone: "has" },
          NONE,
          NONE,
          { text: "一次承認", tone: "has" },
          NONE,
          NONE,
        ],
      },
      {
        label: "接待費用",
        cells: [
          { text: "上限なし（全社決裁）", tone: "limit", supplemented: true },
          { text: "半期で10万円", tone: "limit" },
          { text: "半期で10万円", tone: "limit" },
          { text: "半期で10万円", tone: "limit" },
          NONE,
          NONE,
        ],
      },
      {
        label: "チームビルディング費",
        cells: [
          { text: "上限なし（全社決裁）", tone: "limit", supplemented: true },
          { text: "半期で2万円／人", tone: "limit" },
          { text: "半期で2万円／人", tone: "limit" },
          { text: "半期で2万円／人", tone: "limit" },
          NONE,
          NONE,
        ],
      },
      {
        label: "商品原価",
        cells: [
          NONE,
          NONE,
          NONE,
          { text: "オフィシャル原価・売価の決定", tone: "has" },
          { text: "ショット原価・売価の原案作成", tone: "has" },
          NONE,
        ],
      },
    ],
  },
  {
    id: "people",
    title: "人事・組織",
    description:
      "任用（人を役職に就ける）権限と、組織構成（箱を作る／人を配置する）権限は別。任用は必ず2レイヤー上が持つ。",
    rows: [
      {
        label: "人事（任用・組織構成）",
        cells: [
          { text: "執行役員・DMの任用", tone: "has" },
          { text: "TM・Lの任用", tone: "has" },
          { text: "TM・Lの任用", tone: "has" },
          { text: "Division内の組織構成", tone: "has" },
          { text: "TM内の組織構成", tone: "has" },
          { text: "Unit内の組織構成", tone: "has" },
        ],
      },
      {
        label: "社員採用",
        sublabel: "※インターンは別ルール",
        cells: [
          { text: "採用決裁", tone: "has" },
          { text: "全社採用計画／面接", tone: "has" },
          { text: "全社採用計画／面接", tone: "has" },
          { text: "Division内採用計画／面接", tone: "has" },
          { text: "チーム内採用計画／面接", tone: "has" },
          NONE,
        ],
      },
    ],
  },
  {
    id: "management",
    title: "経営・計画",
    description: "見る数字の範囲＝立てる計画の範囲。自分のレイヤーのPLに責任を持つ。",
    rows: [
      {
        label: "経営管理（数字）",
        cells: [
          { text: "全社経営数字", tone: "has" },
          { text: "全社経営数字", tone: "has" },
          NONE,
          { text: "Division内経営数字", tone: "has" },
          { text: "TM内経営数字", tone: "has" },
          NONE,
        ],
      },
      {
        label: "事業計画",
        cells: [
          { text: "全社事業計画の最終決裁", tone: "has", supplemented: true },
          { text: "全社事業計画", tone: "has" },
          { text: "全社事業計画", tone: "has" },
          { text: "Division事業計画", tone: "has" },
          { text: "チーム事業計画", tone: "has" },
          NONE,
        ],
      },
    ],
  },
  {
    id: "reward",
    title: "評価・報酬",
    description: "給与は原案をDMが作り、COOが承認し、CEOが決裁する3段構え。",
    rows: [
      {
        label: "給与決裁",
        cells: [
          { text: "決裁", tone: "has" },
          { text: "予算計画の原案承認", tone: "has" },
          NONE,
          { text: "予算計画の原案作成", tone: "has" },
          NONE,
          NONE,
        ],
      },
    ],
  },
];

/* ─────────── 評価者（ミッション面談）マトリクス ─────────── */

export type MlEvaluatorRow = {
  /** 被評価者のレイヤー */
  target: string;
  first: string;
  second: string;
  note?: string;
};

export const ML_EVALUATOR_ROWS: MlEvaluatorRow[] = [
  {
    target: "MG以下（メンバー・リーダー）",
    first: "TM",
    second: "DM",
    note: "TM不在の組織は、それぞれ1レイヤーずつ繰り上げる",
  },
  { target: "MG以上", first: "DM", second: "COO ／ CTO・CRO" },
  { target: "DM以上", first: "COO ／ CTO・CRO", second: "CEO" },
  { target: "執行役員以上", first: "CEO", second: "—" },
];

export const ML_LEGEND: { mark: string; meaning: string }[] = [
  { mark: "—", meaning: "その役職には権限がない（該当なし）" },
  { mark: "★", meaning: "原表では空欄。CEOの全社決裁権に含まれるため補完した項目" },
  { mark: "DM", meaning: "Divisionマネージャー" },
  { mark: "TM", meaning: "Teamマネージャー" },
  { mark: "L", meaning: "リーダー（Unitリーダー・TMリーダー）" },
  { mark: "MG", meaning: "マネージャー" },
];

export const ML_SOURCE_URL =
  "https://app.notion.com/p/1b67a40973ec804c809cfe8dceec74be";

/**
 * チャレンジ任用の注意書き。組織図タブの「実質マネージャー」表示と対になる説明で、
 * MTGで挙がった「本人も自分に権限があるか分かっていない」への直接の回答。
 */
export const ML_CHALLENGE_NOTE =
  "チャレンジ任用（CDM／CTM／CTL）は役割を先行して担う任用で、上表の決裁権は持ちません。" +
  "決裁が必要なときは「組織図」タブに表示されている実質マネージャーに上げてください。";
