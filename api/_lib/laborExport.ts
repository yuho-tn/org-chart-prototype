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
} from "../../src/lib/laborCost.js";

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
    /** 取得できた元テーブルの行数。ページング欠損を目視・機械検証できるようにするため。 */
    rowCounts: Record<string, number>;
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

export type Tables = Record<(typeof TABLES)[number], any[]>;

/**
 * service_role で labor_* を読む（RLSはdefault-denyのため anon では読めない）。
 *
 * ⚠ PostgREST は1リクエスト既定1000行で打ち切る。labor_amounts は3000行近くあるため、
 * select("*") のままだと**エラーも警告も出さずに欠けた金額で集計が通ってしまう**
 * （2026-08-16 本番実測: 全社総計が 56,081.6 → 14,949.6 に化けた）。必ず range で
 * 最終ページまで取り切り、取得件数を diagnostics に出して欠損を目視できるようにする。
 */
const PAGE = 1000;

/**
 * 各テーブルの並び順（画面側 useLaborCostStore.load と同じ）。
 * ⚠ ORDER BY 無しの range ページングは、ページをまたいで行が重複・欠落しうる
 * （PostgreSQL は順序を保証しない）。1000行を超えうる labor_amounts / labor_assignments は必ず並べる。
 * 加えて labor_people / labor_tms の並びは
 * DIV按分のメンバー表示順・TM表示順そのものなので、画面と揃えないと見た目がずれる。
 */
const ORDER: Record<(typeof TABLES)[number], string[]> = {
  labor_terms: ["sort_order", "code"],
  labor_people: ["sort_order", "id"],
  labor_assignments: ["person_id", "term", "half", "quarter"],
  labor_amounts: ["person_id", "term", "slot"],
  labor_tms: ["sort_order", "tm"],
  // 以下は画面側も並べずに読んでいる（数十行＝1ページで収まる）。並べ替えると
  // 按分比率の注記の並び（frontRatios のキー順＝labor_front_targets の行順）が画面とずれる。
  labor_dept_map: [],
  labor_front_targets: [],
  labor_tm_targets: [],
  labor_settings: [],
};

export async function fetchLaborTables(url: string, serviceRoleKey: string): Promise<Tables> {
  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

  const fetchAll = async (table: (typeof TABLES)[number]): Promise<any[]> => {
    const rows: any[] = [];
    for (let from = 0; ; from += PAGE) {
      let q = db.from(table).select("*");
      for (const c of ORDER[table]) q = q.order(c);
      const { data, error } = await q.range(from, from + PAGE - 1);
      if (error) throw new Error(`${table} の取得に失敗: ${error.message}`);
      rows.push(...(data ?? []));
      if (!data || data.length < PAGE) return rows;
    }
  };

  const out = {} as Tables;
  for (const t of TABLES) out[t] = await fetchAll(t);
  return out;
}

export function runHalf(tables: Tables, term: TermCode, half: Half): HalfComputation {
  const termRow = tables.labor_terms.find((t) => t.code === term);
  if (!termRow) throw new Error(`期 ${term} が labor_terms にありません`);

  // Supabase の numeric は文字列で返る場合があるため必ず数値化する。
  const assignments: Record<string, any> = {};
  for (const a of tables.labor_assignments) {
    assignments[assignKey(a.person_id, a.term, a.half, a.quarter)] = { ...a, kenmu_rate: Number(a.kenmu_rate) };
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
      rowCounts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])),
      grandTotal: round1(sumAll(product) + sumAll(pools) + sumAll(unrouted)),
      grandTotalFromEngine: round1(grandFromEngine),
    },
  };
}
