/**
 * AI活用レベル（7段階認定制度・2026-07-13 確定）の定義定数。
 *
 * 制度要点:
 *   - 称号は L1 USER 〜 L7 GAME CHANGER の7段階。
 *   - 現在レベル = 当人の ai_level_grants の max(level)（失効なし＝上がるだけ）。
 *   - 認定は 仮認定(provisional) → 本認定(official) の2種。
 *   - 任用接続: L4=リーダー任用入口 / L5=TM入口 / L6=DM入口（役員はL6以上）/
 *     L7=実績指標（任用要件ではない）。任用接続は社員のみ（業務委託・
 *     インターンは分布対象だが任用接続外）。
 *   - 個人レベルは全社フルオープン（全ログインユーザー閲覧可）。
 */

export type AiLevelKind = "provisional" | "official";

export const AI_LEVEL_KIND_LABEL: Record<AiLevelKind, string> = {
  provisional: "仮認定",
  official: "本認定",
};

/** ai_level_grants テーブルの行（migration 0033）。 */
export type AiLevelGrantRow = {
  id: string;
  employee_number: string;
  level: number;
  kind: AiLevelKind;
  certified_at: string; // date (YYYY-MM-DD)
  note: string | null;
  created_by: string | null;
  created_at: string;
};

export type AiLevelColor = {
  /** バッジ・バーの主色 */
  main: string;
  /** 淡色背景（バッジ地・分布バーの淡色面） */
  soft: string;
  /** テキスト色（soft 背景上で読める濃色） */
  text: string;
  /** true なら solid バッジ（main 地に白文字）— 上位レベルの格を出す */
  solid: boolean;
};

export type AiLevelDef = {
  level: number;
  /** 称号（英語コード） */
  code: string;
  /** 称号のサブコピー */
  subcopy: string;
  /** 一言定義 */
  definition: string;
  /** 任用接続ラベル（無い場合 null） */
  appointment: string | null;
  color: AiLevelColor;
};

/**
 * カラーは TalentHub navy 基調（index.css の --navy-* トークンと同系）に
 * 調和させる: 下位=グレー〜navy淡、L4以上=navy濃、L6/L7=gold系
 * （組織図 EXE_COLOR のゴールドと同系統）。
 */
export const AI_LEVELS: AiLevelDef[] = [
  {
    level: 1,
    code: "USER",
    subcopy: "使う",
    definition: "AIチャットで調べ物・文章作成ができる",
    appointment: null,
    color: { main: "#9ca3af", soft: "#f3f4f6", text: "#4b5563", solid: false },
  },
  {
    level: 2,
    code: "DRIVER",
    subcopy: "使いこなす",
    definition: "定型業務をAIで常用時短している",
    appointment: null,
    color: { main: "#64748b", soft: "#eceff3", text: "#334155", solid: false },
  },
  {
    level: 3,
    code: "HACKER",
    subcopy: "仕事を組み直す",
    definition: "自業務の主要工程をAI前提に再設計している",
    appointment: null,
    color: { main: "#3A5F9E", soft: "#DCE6F5", text: "#274B85", solid: false },
  },
  {
    level: 4,
    code: "BUILDER",
    subcopy: "仕組みをつなぐ",
    definition: "複数ツール連携のワークフローで半自動化している",
    appointment: "リーダー任用入口",
    color: { main: "#274B85", soft: "#B9CCE8", text: "#122A52", solid: false },
  },
  {
    level: 5,
    code: "COMMANDER",
    subcopy: "エージェントに任せる",
    definition: "AIエージェントを構築しチーム実装・教育している",
    appointment: "TM入口",
    color: { main: "#122A52", soft: "#DCE6F5", text: "#ffffff", solid: true },
  },
  {
    level: 6,
    code: "CREATOR",
    subcopy: "部門を変えるものを作る",
    definition: "AIツール/アプリを開発し部門業務を改革している",
    appointment: "DM入口（役員はL6以上）",
    color: { main: "#a16207", soft: "#fef3c7", text: "#ffffff", solid: true },
  },
  {
    level: 7,
    code: "GAME CHANGER",
    subcopy: "事業を変える",
    definition: "AI前提の事業改変・少人数事業立ち上げを実現している",
    appointment: "実績指標（任用要件ではない）",
    color: { main: "#854d0e", soft: "#fde68a", text: "#ffffff", solid: true },
  },
];

const BY_LEVEL = new Map(AI_LEVELS.map((d) => [d.level, d]));

/** レベル番号 → 定義。範囲外は undefined。 */
export function aiLevelDef(level: number | null | undefined): AiLevelDef | undefined {
  if (level == null) return undefined;
  return BY_LEVEL.get(level);
}

/** 表示ラベル（例: "L4 BUILDER"）。 */
export function aiLevelLabel(level: number): string {
  const d = BY_LEVEL.get(level);
  return d ? `L${d.level} ${d.code}` : `L${level}`;
}

export type CurrentAiLevel = {
  level: number;
  def: AiLevelDef;
  /** 現在レベルの認定種別: 同レベルに official があれば official。 */
  kind: AiLevelKind;
  /** 現在レベルの認定日（同レベル内で最新の certified_at）。 */
  certified_at: string;
};

/**
 * 1人分の grants から現在レベルを算出する。
 * 現在レベル = max(level)。同レベルに official と provisional が両方
 * あれば official 扱い（仮→本の昇格は同レベル再付与で表現する）。
 */
export function currentLevelOfGrants(
  grants: AiLevelGrantRow[],
): CurrentAiLevel | null {
  let best: AiLevelGrantRow | null = null;
  for (const g of grants) {
    const def = BY_LEVEL.get(g.level);
    if (!def) continue; // 範囲外レベルは無視（check 制約上来ないはず）
    if (
      !best ||
      g.level > best.level ||
      (g.level === best.level &&
        ((g.kind === "official" && best.kind !== "official") ||
          (g.kind === best.kind && g.certified_at > best.certified_at)))
    ) {
      best = g;
    }
  }
  if (!best) return null;
  const def = BY_LEVEL.get(best.level)!;
  return {
    level: best.level,
    def,
    kind: best.kind,
    certified_at: best.certified_at,
  };
}

/**
 * 全 grants から employee_number → 現在レベルの Map を作る
 * （ダッシュボード・一覧バッジの共通集計）。
 */
export function currentLevelMap(
  grants: AiLevelGrantRow[],
): Map<string, CurrentAiLevel> {
  const byEmp = new Map<string, AiLevelGrantRow[]>();
  for (const g of grants) {
    const arr = byEmp.get(g.employee_number);
    if (arr) arr.push(g);
    else byEmp.set(g.employee_number, [g]);
  }
  const out = new Map<string, CurrentAiLevel>();
  for (const [num, arr] of byEmp) {
    const cur = currentLevelOfGrants(arr);
    if (cur) out.set(num, cur);
  }
  return out;
}

/**
 * 雇用区分の3バケット分類（分布の別枠集計用）。
 * 社員(default) / 業務委託 / インターン・アルバイト。
 * 任用接続（L4=リーダー入口等）は「社員」のみ適用。
 */
export type EmploymentBucket = "employee" | "contractor" | "intern";

export const EMPLOYMENT_BUCKET_LABEL: Record<EmploymentBucket, string> = {
  employee: "社員",
  contractor: "業務委託",
  intern: "インターン・アルバイト",
};

export function employmentBucketOf(
  employmentType: string | null | undefined,
): EmploymentBucket {
  if (!employmentType) return "employee";
  if (/業務委託|委託|外注|contractor|freelance/i.test(employmentType)) {
    return "contractor";
  }
  if (/インターン|intern|アルバイト|パート|part[\s-]?time/i.test(employmentType)) {
    return "intern";
  }
  return "employee";
}
