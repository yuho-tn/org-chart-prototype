/**
 * P3: MBTI 16タイプマスター＋オリジナルSVGアバター。
 *   • 16タイプの選択式（自由入力廃止）。保存は employee_profiles.mbti(text) に
 *     4文字コード（例: "ENTJ"）を入れる。
 *   • 4グループ×4タイプ：分析家(NT)=紫 / 外交官(NF)=緑 / 番人(SJ)=青 / 探検家(SP)=黄
 *   • アバターは自作の抽象キャラSVG（16personalities の画像・文面はコピーしない）。
 *     4文字コードからパラメトリックに生成し、16タイプで見分けがつくようにする。
 *   • ニックネーム（建築家/仲介者 等）は一般名称、説明は自前の短文。
 */

export type MbtiGroup = "analyst" | "diplomat" | "sentinel" | "explorer";

export const MBTI_GROUP_LABEL: Record<MbtiGroup, string> = {
  analyst: "分析家",
  diplomat: "外交官",
  sentinel: "番人",
  explorer: "探検家",
};

/** グループカラー（要件 7-3）。 */
export const MBTI_GROUP_COLOR: Record<MbtiGroup, string> = {
  analyst: "#7C3AED", // 紫 (NT)
  diplomat: "#16A34A", // 緑 (NF)
  sentinel: "#2563EB", // 青 (SJ)
  explorer: "#CA8A04", // 黄 (SP)
};

export type MbtiType = {
  code: string; // 4文字（大文字）
  group: MbtiGroup;
  nickname: string; // 日本語ニックネーム（一般名称）
  blurb: string; // 自前の短文説明（2〜3行）
};

export const MBTI_TYPES: MbtiType[] = [
  // ── 分析家（NT）──
  { code: "INTJ", group: "analyst", nickname: "建築家", blurb: "戦略と論理で未来を設計する人。独自のビジョンを描き、粘り強く形にしていく。" },
  { code: "INTP", group: "analyst", nickname: "論理学者", blurb: "知的好奇心が尽きない探究者。物事の仕組みを深く考え、新しい理論を組み立てる。" },
  { code: "ENTJ", group: "analyst", nickname: "指揮官", blurb: "大胆で意志の強いリーダー。目標に向けて人と道筋を力強く導く。" },
  { code: "ENTP", group: "analyst", nickname: "討論者", blurb: "機知に富んだ発想家。常識を疑い、議論とアイデアで可能性を広げる。" },

  // ── 外交官（NF）──
  { code: "INFJ", group: "diplomat", nickname: "提唱者", blurb: "静かな理想主義者。強い信念を胸に、人と社会をより良い方へ導こうとする。" },
  { code: "INFP", group: "diplomat", nickname: "仲介者", blurb: "詩的で心優しい理想家。自分の価値観を大切にし、意味あることに情熱を注ぐ。" },
  { code: "ENFJ", group: "diplomat", nickname: "主人公", blurb: "カリスマ性のある励まし役。人の可能性を信じ、周囲を巻き込んで前へ進む。" },
  { code: "ENFP", group: "diplomat", nickname: "運動家", blurb: "情熱的で創造的な自由人。人とのつながりと新しい体験にわくわくする。" },

  // ── 番人（SJ）──
  { code: "ISTJ", group: "sentinel", nickname: "管理者", blurb: "実直で信頼できる実務家。事実と責任を重んじ、着実に物事を積み上げる。" },
  { code: "ISFJ", group: "sentinel", nickname: "擁護者", blurb: "献身的で温かい守り手。周囲を細やかに気づかい、縁の下で支える。" },
  { code: "ESTJ", group: "sentinel", nickname: "幹部", blurb: "秩序を重んじるまとめ役。ルールと段取りで組織を効率よく動かす。" },
  { code: "ESFJ", group: "sentinel", nickname: "領事", blurb: "面倒見のよい社交家。人の役に立ち、場の調和を保つことに喜びを感じる。" },

  // ── 探検家（SP）──
  { code: "ISTP", group: "explorer", nickname: "巨匠", blurb: "冷静で実践的な職人肌。手を動かして仕組みを解き明かすのが得意。" },
  { code: "ISFP", group: "explorer", nickname: "冒険家", blurb: "柔軟で感性豊かなアーティスト。今この瞬間の美しさと自由を大切にする。" },
  { code: "ESTP", group: "explorer", nickname: "起業家", blurb: "エネルギッシュな行動派。リスクを恐れず、その場で最適解を掴み取る。" },
  { code: "ESFP", group: "explorer", nickname: "エンターテイナー", blurb: "陽気で人を楽しませる盛り上げ役。周囲を明るくし、場に活気を生む。" },
];

export const MBTI_BY_CODE: Record<string, MbtiType> = Object.fromEntries(
  MBTI_TYPES.map((t) => [t.code, t]),
);

/** グループ順（分析家→外交官→番人→探検家）でカードグリッド用に並べる。 */
export const MBTI_GROUP_ORDER: MbtiGroup[] = [
  "analyst",
  "diplomat",
  "sentinel",
  "explorer",
];

/** 4文字コードを正規化（大文字・16タイプに一致するものだけ返す。旧・自由入力の
 *  ゆらぎ吸収）。一致しなければ null。 */
export function normalizeMbti(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = raw.trim().toUpperCase().slice(0, 4);
  return MBTI_BY_CODE[code] ? code : null;
}

/** 16personalities の該当タイプページへの外部リンク（日本語）。 */
export function mbtiExternalUrl(code: string): string {
  return `https://www.16personalities.com/ja/${code.toLowerCase()}-型の性格`;
}

/**
 * オリジナルの抽象キャラアバターSVG（viewBox 0 0 64 64）を4文字コードから生成。
 * グループカラーを地色に、E/I・N/S・T/F・J/P の各軸で顔パーツを変えて
 * 16タイプが見分けられるようにする（16personalities の意匠は用いない）。
 */
export function mbtiAvatarSvg(code: string): string {
  const t = MBTI_BY_CODE[code];
  const color = t ? MBTI_GROUP_COLOR[t.group] : "#6B7280";
  const [e, n, f, j] = code.toUpperCase().split("");
  const extrovert = e === "E";
  const intuitive = n === "N";
  const feeling = f === "F";
  const judging = j === "J";

  // 輪郭: J=角丸四角 / P=円
  const body = judging
    ? `<rect x="8" y="8" width="48" height="48" rx="12" fill="${color}"/>`
    : `<circle cx="32" cy="32" r="24" fill="${color}"/>`;

  // 頭上アクセント: N=アンテナ(星) / S=横ライン(帽子つば)
  const antenna = intuitive
    ? `<line x1="32" y1="10" x2="32" y2="2" stroke="${color}" stroke-width="2.5"/><circle cx="32" cy="2.5" r="2.5" fill="${color}"/>`
    : `<rect x="18" y="12" width="28" height="4" rx="2" fill="rgba(255,255,255,0.85)"/>`;

  // 目: E=大きく開いた丸 / I=控えめな細目
  const eyes = extrovert
    ? `<circle cx="24" cy="30" r="4.5" fill="#fff"/><circle cx="40" cy="30" r="4.5" fill="#fff"/><circle cx="24" cy="30" r="2" fill="${color}"/><circle cx="40" cy="30" r="2" fill="${color}"/>`
    : `<rect x="20" y="29" width="8" height="3" rx="1.5" fill="#fff"/><rect x="36" y="29" width="8" height="3" rx="1.5" fill="#fff"/>`;

  // 口: F=笑顔カーブ / T=直線
  const mouth = feeling
    ? `<path d="M24 41 Q32 48 40 41" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>`
    : `<line x1="25" y1="43" x2="39" y2="43" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/>`;

  // body を先に描く（S型の帽子つばが body に隠れないよう antenna は body の後）。
  return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${code}">${body}${antenna}${eyes}${mouth}</svg>`;
}

/** アバターSVGを data URI 化（img src 用）。 */
export function mbtiAvatarDataUri(code: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(mbtiAvatarSvg(code))}`;
}
