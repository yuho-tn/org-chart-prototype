/**
 * P3: ストレングスファインダー（CliftonStrengths）34資質マスター。
 *   • 34資質から5つを順位付きで選択する（1〜5位・重複不可）。保存は
 *     employee_profiles.strengths（jsonb string[]・配列順＝順位）に資質 id を入れる。
 *   • 4領域カラー：実行力=紫 / 影響力=オレンジ / 人間関係構築力=青 / 戦略的思考力=緑
 *   • description は自前の日本語短文（裕鵬さん提供シート受領後に差し替え可能な構造）。
 */

export type StrengthDomain =
  | "executing"
  | "influencing"
  | "relationship"
  | "strategic";

export const STRENGTH_DOMAIN_LABEL: Record<StrengthDomain, string> = {
  executing: "実行力",
  influencing: "影響力",
  relationship: "人間関係構築力",
  strategic: "戦略的思考力",
};

/** 4領域カラー（要件 7-4）。バッジ背景・ドット・凡例で共用。 */
export const STRENGTH_DOMAIN_COLOR: Record<StrengthDomain, string> = {
  executing: "#7C3AED", // 紫
  influencing: "#EA7317", // オレンジ
  relationship: "#2563EB", // 青
  strategic: "#16A34A", // 緑
};

export type StrengthQuality = {
  /** 安定 id（英語資質名の小文字）。保存値に使う。 */
  id: string;
  /** 日本語資質名。 */
  name_ja: string;
  domain: StrengthDomain;
  /** 自前の短い説明（差し替え可能）。 */
  description: string;
};

/** CliftonStrengths 34資質（4領域）。順序は領域→一般的な並び。 */
export const STRENGTHS: StrengthQuality[] = [
  // ── 実行力（Executing）9資質 ──
  { id: "achiever", name_ja: "達成欲", domain: "executing", description: "常に何かを成し遂げたいという強い欲求を持ち、日々の達成感を原動力にする。" },
  { id: "arranger", name_ja: "アレンジ", domain: "executing", description: "人やリソースを最適に組み合わせ、変化に応じて柔軟に段取りを組み直せる。" },
  { id: "belief", name_ja: "信念", domain: "executing", description: "揺るがない核となる価値観を持ち、それが人生と仕事に一貫した意味を与える。" },
  { id: "consistency", name_ja: "公平性", domain: "executing", description: "誰もが平等に扱われるべきと考え、明確なルールで一貫性を保つ。" },
  { id: "deliberative", name_ja: "慎重さ", domain: "executing", description: "決断の前にリスクを丁寧に見極め、慎重に選択を積み重ねる。" },
  { id: "discipline", name_ja: "規律性", domain: "executing", description: "秩序と構造を好み、計画・ルーティンで物事を確実に前へ進める。" },
  { id: "focus", name_ja: "目標志向", domain: "executing", description: "目的地を定め、そこに向けて優先順位を絞り込み無駄なく進む。" },
  { id: "responsibility", name_ja: "責任感", domain: "executing", description: "引き受けたことは必ずやり遂げ、約束と誠実さを何より重んじる。" },
  { id: "restorative", name_ja: "回復志向", domain: "executing", description: "問題を見つけ出し、原因を突き止めて解決することにやりがいを感じる。" },

  // ── 影響力（Influencing）8資質 ──
  { id: "activator", name_ja: "活発性", domain: "influencing", description: "考えを即行動に移し、動き出すことで物事を前進させる。" },
  { id: "command", name_ja: "指令性", domain: "influencing", description: "主導権を握り、状況を明確にして周囲を決断へ導く。" },
  { id: "communication", name_ja: "コミュニケーション", domain: "influencing", description: "考えや情報を言葉にして生き生きと伝え、人を惹きつける。" },
  { id: "competition", name_ja: "競争性", domain: "influencing", description: "他者との比較を糧にし、1番になることでパフォーマンスを高める。" },
  { id: "maximizer", name_ja: "最上志向", domain: "influencing", description: "平均ではなく卓越を目指し、強みを一流へ磨き上げることに注力する。" },
  { id: "self_assurance", name_ja: "自己確信", domain: "influencing", description: "自分の判断と能力を信じ、不確実な状況でも自信を持って進む。" },
  { id: "significance", name_ja: "自我", domain: "influencing", description: "重要な存在でありたいと願い、価値ある成果で認められることを目指す。" },
  { id: "woo", name_ja: "社交性", domain: "influencing", description: "初対面の人と打ち解けるのが得意で、新たなつながりを築くことを楽しむ。" },

  // ── 人間関係構築力（Relationship Building）9資質 ──
  { id: "adaptability", name_ja: "適応性", domain: "relationship", description: "今この瞬間に柔軟に対応し、予定変更もしなやかに乗りこなす。" },
  { id: "connectedness", name_ja: "運命思考", domain: "relationship", description: "すべての出来事はつながっていると捉え、その意味を大切にする。" },
  { id: "developer", name_ja: "成長促進", domain: "relationship", description: "他者の可能性を見抜き、小さな成長を後押しすることに喜びを感じる。" },
  { id: "empathy", name_ja: "共感性", domain: "relationship", description: "相手の感情を敏感に察知し、その気持ちに寄り添える。" },
  { id: "harmony", name_ja: "調和性", domain: "relationship", description: "対立を避け、合意点を探ることで人と物事を円滑に進める。" },
  { id: "includer", name_ja: "包含", domain: "relationship", description: "誰も取り残さず、輪の中に迎え入れることを自然に行う。" },
  { id: "individualization", name_ja: "個別化", domain: "relationship", description: "一人ひとりの個性を見極め、その人に合った関わり方をする。" },
  { id: "positivity", name_ja: "ポジティブ", domain: "relationship", description: "熱意と前向きさで周囲を明るくし、場のエネルギーを高める。" },
  { id: "relator", name_ja: "親密性", domain: "relationship", description: "少数の深い関係を大切にし、信頼で結ばれたつながりを育む。" },

  // ── 戦略的思考力（Strategic Thinking）8資質 ──
  { id: "analytical", name_ja: "分析思考", domain: "strategic", description: "客観的な事実とデータで物事を検証し、根拠を突き詰める。" },
  { id: "context", name_ja: "原点思考", domain: "strategic", description: "過去の経緯を踏まえて現在を理解し、判断の土台にする。" },
  { id: "futuristic", name_ja: "未来志向", domain: "strategic", description: "先の可能性を鮮やかに描き、そのビジョンで人を鼓舞する。" },
  { id: "ideation", name_ja: "着想", domain: "strategic", description: "新しいアイデアや切り口を次々と生み出すことに喜びを感じる。" },
  { id: "input", name_ja: "収集心", domain: "strategic", description: "情報・知識・モノを集め、いつか役立つ蓄えとして大切にする。" },
  { id: "intellection", name_ja: "内省", domain: "strategic", description: "深く考えることを好み、思索を通じて理解を掘り下げる。" },
  { id: "learner", name_ja: "学習欲", domain: "strategic", description: "学び続けるプロセスそのものに喜びを感じ、成長し続ける。" },
  { id: "strategic", name_ja: "戦略性", domain: "strategic", description: "多くの選択肢の中から最短の道筋を素早く見抜く。" },
];

export const STRENGTH_BY_ID: Record<string, StrengthQuality> = Object.fromEntries(
  STRENGTHS.map((s) => [s.id, s]),
);

/** 資質 id → 表示名（未知 id はそのまま返す＝旧・自由入力値の後方互換）。 */
export function strengthName(id: string): string {
  return STRENGTH_BY_ID[id]?.name_ja ?? id;
}

/** 資質 id → 領域カラー（未知 id はニュートラルグレー）。 */
export function strengthColor(id: string): string {
  const q = STRENGTH_BY_ID[id];
  return q ? STRENGTH_DOMAIN_COLOR[q.domain] : "#6B7280";
}

/** 旧・自由入力の日本語資質名から id へ逆引き（移行の後方互換用）。 */
export const STRENGTH_ID_BY_NAME: Record<string, string> = Object.fromEntries(
  STRENGTHS.map((s) => [s.name_ja, s.id]),
);

/** 保存値（資質 id or 旧・日本語名の混在）を最大5件の id 配列へ正規化。 */
export function normalizeStrengthIds(raw: string[]): string[] {
  const out: string[] = [];
  for (const s of raw) {
    const id = STRENGTH_BY_ID[s] ? s : STRENGTH_ID_BY_NAME[s];
    if (id && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 5);
}
