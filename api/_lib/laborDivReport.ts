/**
 * DIV別人件費ページ（#/labor/div/:target）の集計本体（HTTP層から分離）。
 *
 * ⚠ 人件費は機密。このモジュールは「target 1件分だけ」を返す設計にし、
 * 他DIV・他プールのメンバー明細（個人の給与）が一切混ざらないようにする。
 * 認可判定（誰が target を見られるか）は呼び出し側（api/labor-div-report.ts）が行う。
 */
import type { Half, TermCode, DivBreakdown, AllocPoolBreakdown } from "../../src/lib/laborCost.js";
import { fetchLaborTables, runHalf, type Tables } from "./laborExport.js";

/** comp.divs（プロダクトDIV・TM内訳あり）。役員は機微度が高いため対象外。 */
export const DIV_TARGETS = ["SNS DIV", "マーケティングDIV", "制作DIV", "AI DIV"] as const;
/** comp.pools（按分原資プール）。 */
export const POOL_TARGETS = ["フロントDIV", "HR TM", "コーポレートTM", "開発TM"] as const;
export const ALL_LABOR_DIV_TARGETS = [...DIV_TARGETS, ...POOL_TARGETS] as const;
export type LaborDivTarget = (typeof ALL_LABOR_DIV_TARGETS)[number];

export function isLaborDivTarget(x: string): x is LaborDivTarget {
  return (ALL_LABOR_DIV_TARGETS as readonly string[]).includes(x);
}

export type LaborDivHalfReport = {
  months: readonly string[];
  block: DivBreakdown | AllocPoolBreakdown;
};

export type LaborDivReport = {
  target: LaborDivTarget;
  kind: "div" | "pool";
  term: TermCode;
  generatedAt: string;
  /** その半期にデータが無ければ null（メンバー0名でも block 自体はゼロ埋めで返る想定）。 */
  halves: Record<Half, LaborDivHalfReport | null>;
};

export async function buildLaborDivReport(
  url: string,
  serviceRoleKey: string,
  term: TermCode,
  target: LaborDivTarget,
): Promise<LaborDivReport> {
  const tables: Tables = await fetchLaborTables(url, serviceRoleKey);
  const isPool = (POOL_TARGETS as readonly string[]).includes(target);

  const halves: LaborDivReport["halves"] = { H1: null, H2: null };
  for (const half of ["H1", "H2"] as Half[]) {
    const c = runHalf(tables, term, half);
    const block: DivBreakdown | AllocPoolBreakdown | undefined = isPool
      ? c.pools.find((p) => p.name === target)
      : c.divs.find((d) => d.div === target);
    if (block) halves[half] = { months: c.months, block };
  }

  return {
    target,
    kind: isPool ? "pool" : "div",
    term,
    generatedAt: new Date().toISOString(),
    halves,
  };
}
