/**
 * 人件費管理モジュール（#/labor）のドメイン型と計算エンジン。
 *
 * 単位はすべて「万円」（元スプレッドシート準拠）。
 * 期: '1' | '2' | '2.5' | '3' | '4' | '5'。H1=7〜12月、H2=翌年1〜6月。
 *
 * 按分ロジック（5期 DIV按分・ローデータ出力の仕様）:
 *   - ボーナス（夏ボ/冬ボ）は当該半期の6ヶ月に均等按分（÷6）
 *   - 兼務者は兼務率で分割計上（所属に 1-rate、兼務先に rate）
 *   - 社会保険料は (給与+ボーナス按分) × insurance_rate を加算
 *   - フロント所属の総コストは DIV別売上目標（半期固定）比で各DIVへ按分
 *   - コーポレートは按分せずコーポレート費として出力
 *   - 途中入社は在籍月（金額が入っている月）のみ計上＝月次データそのまま
 */

// ── 型 ──────────────────────────────────────────────────────────────

export type TermCode = "1" | "2" | "2.5" | "3" | "4" | "5";
export type Half = "H1" | "H2";

/** H1 slots then H2 slots. 'BS'=夏ボ / 'BW'=冬ボ */
export type Slot =
  | "7" | "8" | "9" | "10" | "11" | "12" | "BS"
  | "1" | "2" | "3" | "4" | "5" | "6" | "BW";

export const H1_MONTHS = ["7", "8", "9", "10", "11", "12"] as const;
export const H2_MONTHS = ["1", "2", "3", "4", "5", "6"] as const;
export const H1_SLOTS: Slot[] = ["BS", "7", "8", "9", "10", "11", "12"];
export const H2_SLOTS: Slot[] = ["BW", "1", "2", "3", "4", "5", "6"];

export function halfOfSlot(slot: Slot): Half {
  return slot === "BS" || ["7", "8", "9", "10", "11", "12"].includes(slot)
    ? "H1"
    : "H2";
}

export type LaborTermRow = {
  code: TermCode;
  label: string;
  start_year: number;
  sort_order: number;
};

export type LaborPersonRow = {
  id: string;
  name: string;
  employee_number: string | null;
  hired_at: string | null;
  departed: boolean;
  sort_order: number;
  /** インセンティブの売上に対する掛け率（0.05=5%）。フロント陣のみ・null=対象外 */
  incentive_rate?: number | null;
  /** 手動追加の見立て行（マスター未登録・削除可）。0041で追加。 */
  is_manual?: boolean;
};

export type LaborAssignmentRow = {
  person_id: string;
  term: TermCode;
  half: Half;
  dept: string | null;
  kenmu_dept: string | null;
  kenmu_rate: number;
  tm: string | null;
  /** 兼務先のTM（0042）。null=兼務先DIV直計上。所属側のtmとは独立。 */
  kenmu_tm: string | null;
};

export type LaborAmountRow = {
  person_id: string;
  term: TermCode;
  slot: Slot;
  amount: number;
  is_forecast: boolean;
};

export type DeptTreatment = "product" | "front" | "corporate";

/** 按分プールの表示グループ（0040）。front=フロント按分 / overhead=HR/開発/コーポ・その他按分 */
export type AllocGroup = "front" | "overhead";

export type LaborDeptMapRow = {
  term: TermCode;
  dept: string;
  div: string | null;
  treatment: DeptTreatment;
  /** DIVの表示順（0037→0039で追加）。未設定は末尾扱い。 */
  sort_order?: number;
  /** treatment='front' の按分グループ（0040）。未設定は 'overhead' 扱い。 */
  alloc_group?: AllocGroup | null;
};

export type LaborTmRow = { tm: string; div: string; sort_order: number };

export type LaborFrontTargetRow = {
  term: TermCode;
  half: Half;
  div: string;
  sales_target: number;
};

// ── 表示ヘルパ ───────────────────────────────────────────────────────

/** term × slot → 実カレンダー年月。 */
export function slotYearMonth(
  term: LaborTermRow,
  slot: Slot,
): { year: number; month: number } {
  const half = halfOfSlot(slot);
  if (half === "H1") {
    const month = slot === "BS" ? 7 : Number(slot);
    return { year: term.start_year, month };
  }
  const month = slot === "BW" ? 12 : Number(slot);
  // 冬ボは下期の頭（12月支給扱い＝start_year年12月）に紐づけるが、
  // 按分計算では月次に均等割りするため出力には単体で出さない。
  return { year: slot === "BW" ? term.start_year : term.start_year + 1, month };
}

export function ymLabel(year: number, month: number): string {
  return `${year}年${month}月`;
}

export function fmtMan(v: number | null | undefined, dash = "—"): string {
  if (v == null) return dash;
  if (v === 0) return "0";
  const r = Math.round(v * 10) / 10;
  return r % 1 === 0 ? r.toLocaleString() : r.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ── データ索引 ──────────────────────────────────────────────────────

export type AmountKey = `${string}::${TermCode}::${Slot}`;
export function amountKey(personId: string, term: TermCode, slot: Slot): AmountKey {
  return `${personId}::${term}::${slot}`;
}

export type AssignKey = `${string}::${TermCode}::${Half}`;
export function assignKey(personId: string, term: TermCode, half: Half): AssignKey {
  return `${personId}::${term}::${half}`;
}

// ── 按分計算 ────────────────────────────────────────────────────────

export type MonthCell = { salary: number; bonusAlloc: number };

export type TmBreakdown = {
  tm: string;
  div: string;
  /** person行: 月次給与（兼務分割後）。key = month slot ('7'..'12' or '1'..'6') */
  members: {
    personId: string;
    name: string;
    share: number; // このTMへの配分率（1 or 兼務分）
    months: Record<string, number>;
    bonus: number; // 半期ボーナス（配分後・按分前の総額）
  }[];
  /** 月次: メンバー給与計 */
  salaryByMonth: Record<string, number>;
  /** 月次: ボーナス按分計（Σ bonus/6） */
  bonusByMonth: Record<string, number>;
  /** 月次: 社保 = (salary+bonus) × rate */
  insuranceByMonth: Record<string, number>;
  /** 月次: プロダクト計 = salary+bonus+insurance */
  totalByMonth: Record<string, number>;
};

export type DivBreakdown = {
  div: string;
  tms: TmBreakdown[];
  productByMonth: Record<string, number>;
  /** フロント按分（group='front' プールの受け分） */
  frontAllocByMonth: Record<string, number>;
  /** HR/開発/コーポ・その他按分（group='overhead' プールの受け分） */
  overheadAllocByMonth: Record<string, number>;
  totalByMonth: Record<string, number>;
};

/** 按分原資プール（フロント/HR/開発/コーポ 等）。売上目標比で各DIVへ配賦。 */
export type AllocPoolBreakdown = {
  name: string;
  group: AllocGroup;
  salaryByMonth: Record<string, number>;
  bonusByMonth: Record<string, number>;
  insuranceByMonth: Record<string, number>;
  totalByMonth: Record<string, number>;
};

export type HalfComputation = {
  term: TermCode;
  half: Half;
  months: readonly string[];
  divs: DivBreakdown[];
  /** 按分原資プール（フロント/HR/開発/コーポ 等・group付き） */
  pools: AllocPoolBreakdown[];
  /** 按分比率（div→ratio・売上目標比） */
  frontRatios: Record<string, number>;
  /** コーポレート費（社保込み）月次。treatment='corporate' 用（5期は0・後方互換） */
  corporateByMonth: Record<string, number>;
  corporateSalaryByMonth: Record<string, number>;
  corporateBonusByMonth: Record<string, number>;
  corporateInsuranceByMonth: Record<string, number>;
  /** 全社総計（プロダクト+全按分プール+コーポレート・按分残差込み） */
  grandTotalByMonth: Record<string, number>;
  /** 原資プールのうちDIVへ配分し切れなかった残差（総計には加算済み） */
  unallocatedByMonth: Record<string, number>;
  /** 按分残差が有意にある（売上目標未登録/0など）＝要確認 */
  unallocated: boolean;
  /** マッピング不明の所属（データ健全性アラート用） */
  unmappedDepts: string[];
};

const UNASSIGNED_TM = "（TM未割当）";
/** TMを持たない設計のDIV（SNS/制作/HR等）でメンバーを直計上する際のラベル。
 *  TMを持つDIVでの UNASSIGNED_TM（＝要割当の警告対象）と区別する。 */
const DIV_DIRECT_TM = "（DIV直計上）";

type Inputs = {
  term: LaborTermRow;
  half: Half;
  people: LaborPersonRow[];
  assignments: Record<AssignKey, LaborAssignmentRow>;
  amounts: Record<AmountKey, LaborAmountRow>;
  deptMap: LaborDeptMapRow[];
  tms: LaborTmRow[];
  frontTargets: LaborFrontTargetRow[];
  insuranceRate: number;
};

export function computeHalf(inp: Inputs): HalfComputation {
  const { term, half, people, assignments, amounts } = inp;
  const months = half === "H1" ? H1_MONTHS : H2_MONTHS;
  const bonusSlot: Slot = half === "H1" ? "BS" : "BW";

  const mapByDept = new Map(
    inp.deptMap.filter((m) => m.term === term.code).map((m) => [m.dept, m]),
  );
  // DIV表示順の正 = labor_dept_map.sort_order（0039で追加）。
  const divSort = new Map<string, number>();
  for (const m of inp.deptMap) {
    if (m.term === term.code && m.div) divSort.set(m.div, m.sort_order ?? 999);
  }
  const divOrder: string[] = [];
  for (const t of [...inp.tms].sort((a, b) => a.sort_order - b.sort_order)) {
    if (!divOrder.includes(t.div)) divOrder.push(t.div);
  }
  for (const m of inp.deptMap) {
    if (m.term === term.code && m.treatment === "product" && m.div && !divOrder.includes(m.div)) {
      divOrder.push(m.div);
    }
  }
  // 売上目標のあるDIVも配分先として必ず並べる（product行が無いDIVでも
  // フロント按分の受け皿を用意し、按分残差＝総計欠落を防ぐ）。
  for (const f of inp.frontTargets) {
    if (f.term === term.code && f.half === half && f.sales_target > 0 && !divOrder.includes(f.div)) {
      divOrder.push(f.div);
    }
  }
  // dept_map の sort_order で並べ替え（未定義DIVは末尾・名前順）。
  divOrder.sort(
    (a, b) => (divSort.get(a) ?? 999) - (divSort.get(b) ?? 999) || a.localeCompare(b),
  );
  // TMを設計上持つDIVの集合（＝未割当を警告対象にするか、DIV直計上にするかの判定）。
  const divsWithTms = new Set(inp.tms.map((t) => t.div));

  const zero = () => Object.fromEntries(months.map((m) => [m, 0])) as Record<string, number>;

  // div → tm → TmBreakdown
  const tmMap = new Map<string, TmBreakdown>();
  const tmDivOf = new Map(inp.tms.map((t) => [t.tm, t.div]));
  const ensureTm = (div: string, tm: string): TmBreakdown => {
    const key = `${div}::${tm}`;
    let b = tmMap.get(key);
    if (!b) {
      b = {
        tm, div, members: [],
        salaryByMonth: zero(), bonusByMonth: zero(),
        insuranceByMonth: zero(), totalByMonth: zero(),
      };
      tmMap.set(key, b);
    }
    return b;
  };

  // 按分原資プール: プール名 → {group, 給与, ボーナス按分}
  type PoolAcc = { group: AllocGroup; salary: Record<string, number>; bonus: Record<string, number> };
  const poolAcc = new Map<string, PoolAcc>();
  const ensurePool = (name: string, group: AllocGroup): PoolAcc => {
    let p = poolAcc.get(name);
    if (!p) { p = { group, salary: zero(), bonus: zero() }; poolAcc.set(name, p); }
    return p;
  };
  const corpSalary = zero(); const corpBonus = zero();
  const unmapped = new Set<string>();

  for (const p of people) {
    const a = assignments[assignKey(p.id, term.code, half)];
    if (!a) continue;
    const monthAmt = (m: string) =>
      amounts[amountKey(p.id, term.code, m as Slot)]?.amount ?? 0;
    const bonus = amounts[amountKey(p.id, term.code, bonusSlot)]?.amount ?? 0;
    const hasAny = bonus !== 0 || months.some((m) => monthAmt(m) !== 0);
    if (!hasAny) continue;

    // 配分先: 所属(1-rate) + 兼務先(rate)。所属側は tm、兼務先側は kenmu_tm を使う（0042）。
    // 元シート仕様: 兼務先が空欄でも兼務率>0なら所属から差し引く
    // （その分はSHO-SAN人件費の外＝どこにも計上しない。例: 丹野30%）。
    const targets: { dept: string; tm: string | null; share: number }[] = [];
    const rate = Math.min(Math.max(a.kenmu_rate ?? 0, 0), 1);
    if (a.dept) targets.push({ dept: a.dept, tm: a.tm ?? null, share: 1 - rate });
    if (a.kenmu_dept && rate > 0) targets.push({ dept: a.kenmu_dept, tm: a.kenmu_tm ?? null, share: rate });
    if (targets.length === 0) continue;

    for (const t of targets) {
      const map = mapByDept.get(t.dept);
      if (!map) { unmapped.add(t.dept); continue; }
      if (map.treatment === "front") {
        const poolName = map.div ?? t.dept;
        const group: AllocGroup = map.alloc_group ?? "overhead";
        const pool = ensurePool(poolName, group);
        for (const m of months) pool.salary[m] += monthAmt(m) * t.share;
        for (const m of months) pool.bonus[m] += (bonus * t.share) / 6;
        continue;
      }
      if (map.treatment === "corporate") {
        for (const m of months) corpSalary[m] += monthAmt(m) * t.share;
        for (const m of months) corpBonus[m] += (bonus * t.share) / 6;
        continue;
      }
      // product
      const div = map.div ?? t.dept;
      // TM: 所属側は tm、兼務先側は kenmu_tm（各ターゲットが自分のTMを持つ・0042）
      const assignedTm = t.tm ?? null;
      // TM割当が別DIVのTMなら、そのTMのDIVを優先（マッピングより実割当）
      const tmDiv = assignedTm ? tmDivOf.get(assignedTm) : undefined;
      const targetDiv = tmDiv ?? div;
      // TM未割当時: そのDIVが設計上TMを持つなら「（TM未割当）」＝要割当、
      // 持たない設計（SNS/制作/HR）なら「（DIV直計上）」でメンバー直計上。
      const tm =
        assignedTm ?? (divsWithTms.has(targetDiv) ? UNASSIGNED_TM : DIV_DIRECT_TM);
      const b = ensureTm(targetDiv, tm);
      const monthsRec: Record<string, number> = {};
      for (const m of months) {
        const v = monthAmt(m) * t.share;
        monthsRec[m] = v;
        b.salaryByMonth[m] += v;
        b.bonusByMonth[m] += (bonus * t.share) / 6;
      }
      b.members.push({
        personId: p.id, name: p.name, share: t.share,
        months: monthsRec, bonus: bonus * t.share,
      });
    }
  }

  const rate = inp.insuranceRate;
  for (const b of tmMap.values()) {
    for (const m of months) {
      b.insuranceByMonth[m] = (b.salaryByMonth[m] + b.bonusByMonth[m]) * rate;
      b.totalByMonth[m] = b.salaryByMonth[m] + b.bonusByMonth[m] + b.insuranceByMonth[m];
    }
  }

  // 各按分プールを社保込みで確定（給与＋ボーナス按分）×率。
  const pools: AllocPoolBreakdown[] = [];
  // プール表示順: front グループ → overhead グループ、各グループ内は名前順。
  const poolNames = [...poolAcc.keys()].sort((a, b) => {
    const ga = poolAcc.get(a)!.group, gb = poolAcc.get(b)!.group;
    if (ga !== gb) return ga === "front" ? -1 : 1;
    return a.localeCompare(b);
  });
  for (const name of poolNames) {
    const acc = poolAcc.get(name)!;
    const ins = zero(); const total = zero();
    for (const m of months) {
      ins[m] = (acc.salary[m] + acc.bonus[m]) * rate;
      total[m] = acc.salary[m] + acc.bonus[m] + ins[m];
    }
    pools.push({
      name, group: acc.group,
      salaryByMonth: acc.salary, bonusByMonth: acc.bonus,
      insuranceByMonth: ins, totalByMonth: total,
    });
  }
  // グループ別の原資合計（按分の分子）
  const groupPool = (g: AllocGroup) => {
    const rec = zero();
    for (const p of pools) if (p.group === g) for (const m of months) rec[m] += p.totalByMonth[m];
    return rec;
  };
  const frontPool = groupPool("front");
  const overheadPool = groupPool("overhead");

  const corpIns = zero(); const corpTotal = zero();
  for (const m of months) {
    corpIns[m] = (corpSalary[m] + corpBonus[m]) * rate;
    corpTotal[m] = corpSalary[m] + corpBonus[m] + corpIns[m];
  }

  const targetsRows = inp.frontTargets.filter(
    (f) => f.term === term.code && f.half === half,
  );
  const targetSum = targetsRows.reduce((s, f) => s + f.sales_target, 0);
  const frontRatios: Record<string, number> = {};
  for (const f of targetsRows) {
    frontRatios[f.div] = targetSum > 0 ? f.sales_target / targetSum : 0;
  }

  // DIV集計。各DIVは自プロダクト＋フロント按分＋間接(overhead)按分。
  const tmSort = new Map(inp.tms.map((t) => [t.tm, t.sort_order]));
  const divs: DivBreakdown[] = [];
  for (const div of divOrder) {
    const tms = [...tmMap.values()]
      .filter((b) => b.div === div)
      .sort((a, b) =>
        (tmSort.get(a.tm) ?? 999) - (tmSort.get(b.tm) ?? 999) || a.tm.localeCompare(b.tm),
      );
    const productByMonth = zero();
    for (const b of tms) for (const m of months) productByMonth[m] += b.totalByMonth[m];
    const ratio = frontRatios[div] ?? 0;
    const frontAllocByMonth = zero();
    const overheadAllocByMonth = zero();
    const totalByMonth = zero();
    for (const m of months) {
      frontAllocByMonth[m] = frontPool[m] * ratio;
      overheadAllocByMonth[m] = overheadPool[m] * ratio;
      totalByMonth[m] = productByMonth[m] + frontAllocByMonth[m] + overheadAllocByMonth[m];
    }
    divs.push({ div, tms, productByMonth, frontAllocByMonth, overheadAllocByMonth, totalByMonth });
  }

  // 各原資グループが実際にDIVへ配分された合計と、配分し切れなかった残差。
  // 売上目標が未登録/全0だと残差が生じる。残差は総計に必ず加算し（金額の
  // 欠落を防ぐ）、警告フラグで可視化する。
  const allocated = zero();
  for (const d of divs) for (const m of months) allocated[m] += d.frontAllocByMonth[m] + d.overheadAllocByMonth[m];
  const poolTotal = zero();
  for (const m of months) poolTotal[m] = frontPool[m] + overheadPool[m];
  const unalloc = zero();
  let unallocated = false;
  for (const m of months) {
    unalloc[m] = poolTotal[m] - allocated[m];
    if (Math.abs(unalloc[m]) > 0.05) unallocated = true;
  }

  const grand = zero();
  for (const m of months) {
    grand[m] =
      divs.reduce((s, d) => s + d.totalByMonth[m], 0) + corpTotal[m] + unalloc[m];
  }

  return {
    term: term.code, half, months, divs,
    pools, frontRatios,
    corporateByMonth: corpTotal,
    corporateSalaryByMonth: corpSalary,
    corporateBonusByMonth: corpBonus,
    corporateInsuranceByMonth: corpIns,
    grandTotalByMonth: grand,
    unallocatedByMonth: unalloc,
    unallocated,
    unmappedDepts: [...unmapped],
  };
}

// ── ローデータ出力 ──────────────────────────────────────────────────

export type RawRow = {
  ym: string;        // '2026年7月'
  tm: string;        // TM名 / 'フロント按分' / '間接費按分' / 'コーポレート' / '—'
  div: string;
  kind: "プロダクト" | "フロント" | "間接費" | "総額" | "コーポレート";
  amount: number;    // 万円（小数1桁丸め）
};

export function buildRawRows(
  term: LaborTermRow,
  comps: HalfComputation[],
): RawRow[] {
  const rows: RawRow[] = [];
  const round1 = (v: number) => Math.round(v * 10) / 10;
  for (const c of comps) {
    for (const m of c.months) {
      const year = c.half === "H1" ? term.start_year : term.start_year + 1;
      const ym = ymLabel(year, Number(m));
      for (const d of c.divs) {
        for (const t of d.tms) {
          rows.push({ ym, tm: t.tm, div: d.div, kind: "プロダクト", amount: round1(t.totalByMonth[m]) });
        }
        rows.push({ ym, tm: "フロント按分", div: d.div, kind: "フロント", amount: round1(d.frontAllocByMonth[m]) });
        rows.push({ ym, tm: "HR/開発/コーポ・その他按分", div: d.div, kind: "間接費", amount: round1(d.overheadAllocByMonth[m]) });
        rows.push({ ym, tm: "—", div: d.div, kind: "総額", amount: round1(d.totalByMonth[m]) });
      }
      // treatment='corporate'（5期は0・後方互換）。非0のときのみ出力。
      const corp = round1(c.corporateByMonth[m]);
      if (corp !== 0) {
        rows.push({ ym, tm: "コーポレート", div: "コーポレート", kind: "コーポレート", amount: corp });
      }
    }
  }
  return rows;
}

export function rawRowsToTsv(rows: RawRow[]): string {
  const head = "年月\tTM\tDiv\t種別\t金額（万円）";
  return [head, ...rows.map((r) => `${r.ym}\t${r.tm}\t${r.div}\t${r.kind}\t${r.amount}`)].join("\n");
}

export function rawRowsToCsv(rows: RawRow[]): string {
  const head = "年月,TM,Div,種別,金額（万円）";
  return [head, ...rows.map((r) => `${r.ym},${r.tm},${r.div},${r.kind},${r.amount}`)].join("\n");
}
