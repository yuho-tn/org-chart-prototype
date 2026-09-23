/**
 * DIV別人件費ページ（#/labor/div/:target）の集計本体（HTTP層から分離）。
 *
 * ⚠ 人件費は機密。このモジュールは「target 1件分だけ」を返す設計にし、
 * 他DIV・他プールのメンバー明細（個人の給与）が一切混ざらないようにする。
 * 認可判定（誰が target を見られるか）は呼び出し側（api/labor-div-report.ts）が行う。
 */
import { createClient } from "@supabase/supabase-js";
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
  /** 按分比率（売上目標比・DIV名→比率）。DIV按分画面のツールバー注記と同じもの。 */
  frontRatios: Record<string, number>;
};

export type LaborDivReport = {
  target: LaborDivTarget;
  kind: "div" | "pool";
  term: TermCode;
  /** 期の開始年（上期=start_year/7〜12・下期=start_year+1/1〜6）。月見出し用。 */
  startYear: number;
  insuranceRate: number;
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
  const report = reportFromTables(tables, term, target);
  await resolveMemberNames(url, serviceRoleKey, tables, report.halves);
  return report;
}

/** 取得済みテーブルから target 1件分を切り出す（純関数・名前解決の前）。 */
export function reportFromTables(tables: Tables, term: TermCode, target: LaborDivTarget): LaborDivReport {
  const isPool = (POOL_TARGETS as readonly string[]).includes(target);

  const halves: LaborDivReport["halves"] = { H1: null, H2: null };
  for (const half of ["H1", "H2"] as Half[]) {
    const c = runHalf(tables, term, half);
    const block: DivBreakdown | AllocPoolBreakdown | undefined = isPool
      ? c.pools.find((p) => p.name === target)
      : c.divs.find((d) => d.div === target);
    if (block) halves[half] = { months: c.months, block, frontRatios: c.frontRatios };
  }

  const termRow = tables.labor_terms.find((t) => t.code === term);
  return {
    target,
    kind: isPool ? "pool" : "div",
    term,
    startYear: Number(termRow?.start_year),
    insuranceRate: Number(
      tables.labor_settings.find((s) => s.key === "insurance_rate")?.value ?? 0.17,
    ),
    generatedAt: new Date().toISOString(),
    halves,
  };
}

type NameRow = { employee_number: string | number; display_name?: string | null; full_name?: string | null };

function blockMembers(halves: LaborDivReport["halves"]): { personId: string; name: string }[] {
  const members: { personId: string; name: string }[] = [];
  for (const h of Object.values(halves)) {
    if (!h) continue;
    const b = h.block as Partial<DivBreakdown & AllocPoolBreakdown>;
    if (b.tms) for (const t of b.tms) members.push(...t.members);
    if (b.members) members.push(...b.members);
  }
  return members;
}

const numByPersonOf = (tables: Tables) =>
  new Map<string, string>(
    tables.labor_people
      .filter((p) => p.employee_number)
      .map((p) => [p.id as string, String(p.employee_number)]),
  );

/**
 * メンバー名を DIV按分画面（LaborDivTab の nameOf）と同じ「正式名称」に置き換える（純関数）。
 * 規則: 従業員マスターの display_name || full_name、無ければ labor_people.name（省略名）。
 */
export function applyMemberNames(tables: Tables, halves: LaborDivReport["halves"], employees: NameRow[]): void {
  const numByPerson = numByPersonOf(tables);
  const nameByNum = new Map<string, string>();
  for (const e of employees) {
    const n = e.display_name || e.full_name;
    if (n) nameByNum.set(String(e.employee_number), n);
  }
  for (const m of blockMembers(halves)) {
    const num = numByPerson.get(m.personId);
    const n = num ? nameByNum.get(num) : undefined;
    if (n) m.name = n;
  }
}

/** 照会するのは返却ブロックに載っているメンバーの社員番号だけ（他DIVの社員は引かない）。 */
async function resolveMemberNames(
  url: string,
  serviceRoleKey: string,
  tables: Tables,
  halves: LaborDivReport["halves"],
): Promise<void> {
  const numByPerson = numByPersonOf(tables);
  const nums = [...new Set(blockMembers(halves).map((m) => numByPerson.get(m.personId)).filter(Boolean))] as string[];
  if (nums.length === 0) return;

  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const { data, error } = await db
    .from("employees")
    .select("employee_number, display_name, full_name")
    .in("employee_number", nums);
  if (error) throw new Error(`employees の取得に失敗: ${error.message}`);
  applyMemberNames(tables, halves, data ?? []);
}
