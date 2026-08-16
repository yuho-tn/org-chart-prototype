/**
 * PL連携用 人件費エクスポートの本体（HTTP層から分離＝テスト可能にするため）。
 *
 * 方針:
 *  - 返すのは「按分前の総額」。PL側は既存の w_tm（TM年間目標/106,000）で按分する。
 *    talent-hub 側の按分（DIV売上目標の半期値）と PL 側の按分は半期の重みだけが違い、
 *    年計は両者 106,000 で一致する。総額を渡せば年計は完全一致し、PLの設計も壊さない。
 *  - TM名は talent-hub 自身の名前のまま出す。PL側の名前への読み替えは消費者(PL)が持つ。
 *  - 送り先の無い金額（TM未割当など）は黙って落とさず `unrouted` に出す。
 *    PL側は unrouted が非空なら取り込みを止められる。
 *  - 突合用に grandTotal を必ず添える（product+pools+unrouted+corporate と一致すること）。
 */
import { createClient } from "@supabase/supabase-js";
import {
  computeHalf, assignKey, amountKey,
  type Half, type TermCode, type HalfComputation,
} from "../../src/lib/laborCost.ts";

/** index0 = 7月 … index11 = 6月（PLの MONTHS 並びと一致させる）。 */
export const MONTH_ORDER = [
  "7月", "8月", "9月", "10月", "11月", "12月",
  "1月", "2月", "3月", "4月", "5月", "6月",
] as const;

export interface LaborExport {
  term: TermCode;
  generatedAt: string;
  unit: "万円";
  monthOrder: readonly string[];
  /** プロダクト（DIV×TM）。key = talent-hub の TM名。 */
  product: Record<string, number[]>;
  /** 按分原資プール。key = talent-hub のプール名（フロントDIV/HR TM/開発TM/コーポレートTM）。 */
  pools: Record<string, number[]>;
  /** 送り先の無い金額（TM未割当・treatment=corporate・按分残差）。空であるべき。 */
  unrouted: Record<string, number[]>;
  diagnostics: {
    unmappedDepts: string[];
    /** product+pools+unrouted の年計。talent-hub の全社総計と一致すること。 */
    grandTotal: number;
    /** computeHalf が返した全社総計の年計（突合の相手）。 */
    grandTotalFromEngine: number;
  };
}

const TABLES = [
  "labor_terms", "labor_people", "labor_assignments", "labor_amounts",
  "labor_dept_map", "labor_tms", "labor_front_targets", "labor_tm_targets",
  "labor_settings",
] as const;

type Tables = Record<(typeof TABLES)[number], any[]>;

/** service_role で labor_* を読む（RLSはdefault-denyのため anon では読めない）。 */
export async function fetchLaborTables(url: string, serviceRoleKey: string): Promise<Tables> {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const out = {} as Tables;
  for (const t of TABLES) {
    const { data, error } = await db.from(t).select("*");
    if (error) throw new Error(`${t} の取得に失敗: ${error.message}`);
    out[t] = data ?? [];
  }
  return out;
}

function runHalf(tables: Tables, term: TermCode, half: Half): HalfComputation {
  const termRow = tables.labor_terms.find((t) => t.code === term);
  if (!termRow) throw new Error(`期 ${term} が labor_terms にありません`);

  // Supabase の numeric は文字列で返る場合があるため必ず数値化する。
  const assignments: Record<string, any> = {};
  for (const a of tables.labor_assignments) {
    assignments[assignKey(a.person_id, a.term, a.half)] = { ...a, kenmu_rate: Number(a.kenmu_rate) };
  }
  const amounts: Record<string, any> = {};
  for (const a of tables.labor_amounts) {
    amounts[amountKey(a.person_id, a.term, a.slot)] = { ...a, amount: Number(a.amount) };
  }

  return computeHalf({
    term: termRow,
    half,
    people: tables.labor_people,
    assignments: assignments as never,
    amounts: amounts as never,
    deptMap: tables.labor_dept_map,
    tms: tables.labor_tms,
    frontTargets: tables.labor_front_targets.map((f) => ({ ...f, sales_target: Number(f.sales_target) })),
    tmTargets: tables.labor_tm_targets.map((t) => ({ ...t, sales_target: Number(t.sales_target) })),
    insuranceRate: Number(
      tables.labor_settings.find((s) => s.key === "insurance_rate")?.value ?? 0.17,
    ),
    // DIV按分ビューと同条件（個人の入退社の凸凹から給与を推測させない）。
    smoothSalary: true,
  });
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function buildLaborExport(tables: Tables, term: TermCode): LaborExport {
  const product: Record<string, number[]> = {};
  const pools: Record<string, number[]> = {};
  const unrouted: Record<string, number[]> = {};
  const put = (rec: Record<string, number[]>, key: string, i: number, v: number) => {
    (rec[key] ??= Array(12).fill(0))[i] += v;
  };

  let grandFromEngine = 0;
  const unmappedDepts = new Set<string>();
  for (const half of ["H1", "H2"] as Half[]) {
    const c = runHalf(tables, term, half);
    for (const d of c.unmappedDepts) unmappedDepts.add(d);
    const base = half === "H1" ? 0 : 6;
    c.months.forEach((m, i) => {
      const at = base + i;
      for (const d of c.divs) {
        for (const t of d.tms) {
          // 「（TM未割当）」「（DIV直計上）」は実TMではない＝PLに送り先が無い。
          const bucket = t.tm.startsWith("（") ? unrouted : product;
          const key = t.tm.startsWith("（") ? `${d.div}/${t.tm}` : t.tm;
          put(bucket, key, at, t.totalByMonth[m]);
        }
      }
      for (const p of c.pools) put(pools, p.name, at, p.totalByMonth[m]);
      if (c.corporateByMonth[m]) put(unrouted, "treatment=corporate", at, c.corporateByMonth[m]);
      if (Math.abs(c.unallocatedByMonth[m]) > 0.05) {
        put(unrouted, "按分残差", at, c.unallocatedByMonth[m]);
      }
      grandFromEngine += c.grandTotalByMonth[m];
    });
  }

  const roundAll = (rec: Record<string, number[]>) => {
    for (const k of Object.keys(rec)) rec[k] = rec[k].map(round1);
    return rec;
  };
  roundAll(product); roundAll(pools); roundAll(unrouted);

  const sumAll = (rec: Record<string, number[]>) =>
    Object.values(rec).reduce((s, arr) => s + arr.reduce((a, b) => a + b, 0), 0);

  return {
    term,
    generatedAt: new Date().toISOString(),
    unit: "万円",
    monthOrder: MONTH_ORDER,
    product, pools, unrouted,
    diagnostics: {
      unmappedDepts: [...unmappedDepts],
      grandTotal: round1(sumAll(product) + sumAll(pools) + sumAll(unrouted)),
      grandTotalFromEngine: round1(grandFromEngine),
    },
  };
}
