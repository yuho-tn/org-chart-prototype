import { useMemo, useState } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { LaborGrid } from "./LaborGrid";
import type { GridColumn, GridEdit, GridRow, GridSort } from "./LaborGrid";
import type { Half, QuarterPart, Slot, TermCode } from "../../lib/laborCost";
import { amountKey, assignKey, ALLOC_TM } from "../../lib/laborCost";

/**
 * 個人別シート: 元スプレッドシート「人件費ローデータ」と同じ列構成を
 * 期ごとに表示・編集する。
 * 列: 名前 | 社員番号 | 入社日 | マスター所属
 *    | 上期・1Q(所属/兼務先/兼務率/夏ボ/7〜9月) | 上期・2Q(所属/兼務先/兼務率/10〜12月/上期計)
 *    | 下期・3Q(所属/兼務先/兼務率/冬ボ/1〜3月) | 下期・4Q(所属/兼務先/兼務率/4〜6月/下期計) | 年計
 *
 * 1Q/2Q（3Q/4Q）は期中（Qまたぎ）の人事異動を表現するための分割で、大半の
 * 従業員は同じ値が入る（0047）。名前・社員番号・入社日・マスター所属は
 * TalentHub 従業員マスター(employees)と employee_number で突合して表示する。
 * 所属(DIV)は「マスター所属」を候補として見ながらプルダウンで手動確定する
 * （マスターの単一部署文字列は自動分離不可）。
 */

const H1_Q1_MONTHS: { key: Slot; title: string }[] = [
  { key: "7", title: "7月" },
  { key: "8", title: "8月" },
  { key: "9", title: "9月" },
];
const H1_Q2_MONTHS: { key: Slot; title: string }[] = [
  { key: "10", title: "10月" },
  { key: "11", title: "11月" },
  { key: "12", title: "12月" },
];
const H2_Q1_MONTHS: { key: Slot; title: string }[] = [
  { key: "1", title: "1月" },
  { key: "2", title: "2月" },
  { key: "3", title: "3月" },
];
const H2_Q2_MONTHS: { key: Slot; title: string }[] = [
  { key: "4", title: "4月" },
  { key: "5", title: "5月" },
  { key: "6", title: "6月" },
];
const H1_BONUS_COL: { key: Slot; title: string } = { key: "BS", title: "夏ボ" };
const H2_BONUS_COL: { key: Slot; title: string } = { key: "BW", title: "冬ボ" };
const H1_AMOUNT_COLS = [H1_BONUS_COL, ...H1_Q1_MONTHS, ...H1_Q2_MONTHS];
const H2_AMOUNT_COLS = [H2_BONUS_COL, ...H2_Q1_MONTHS, ...H2_Q2_MONTHS];

const AMOUNT_KEYS = new Set<string>([
  ...H1_AMOUNT_COLS.map((c) => c.key),
  ...H2_AMOUNT_COLS.map((c) => c.key),
]);

/** H1: 1Q=7〜9月／2Q=10〜12月。H2: 3Q(quarter=1)=1〜3月／4Q(quarter=2)=4〜6月。 */
const QUARTER_LABEL: Record<Half, [string, string]> = {
  H1: ["1Q（7〜9月）", "2Q（10〜12月）"],
  H2: ["3Q（1〜3月）", "4Q（4〜6月）"],
};

const TOTAL_ROW_ID = "__total__";
/** 合計行で足す列（金額・半期計・年計） */
const TOTAL_KEYS = [...AMOUNT_KEYS, "H1:total", "H2:total", "y_total"];
/** TM絞り込みの「未割当」 */
const UNASSIGNED_FILTER = "（TM未割当）";

type FilterQ = "H1:1" | "H1:2" | "H2:1" | "H2:2";
const FILTER_Q_LABEL: Record<FilterQ, string> = {
  "H1:1": "1Q（7〜9月）",
  "H1:2": "2Q（10〜12月）",
  "H2:1": "3Q（1〜3月）",
  "H2:2": "4Q（4〜6月）",
};

/**
 * 従業員マスターの部署パス（例「マーケティング DIV/広告 TM」「AI DIV/プロダクト TM/BAA ユニット」）
 * と役職から、出力TM体系（広告TM/AIO TM/BAA Unit/AXコンサルUnit/代表取締役/執行役員）を推定する。
 * 参照表示専用（自動反映はしない・命名ゆれがあるため手選択の目安）。
 */
function parseMasterTm(
  dept: string | null | undefined,
  pos: string | null | undefined,
): string | null {
  const d = dept ?? "";
  if (/広告/.test(d)) return "広告TM";
  if (/AIO/.test(d)) return "AIO TM";
  if (/LINE/.test(d)) return "AIO TM"; // LINEはAIOに吸収（TM区分は廃止）
  if (/Instagram/i.test(d)) return "Instagram TM";
  if (/デザイン/.test(d)) return "デザインTM";
  if (/エンジニア/.test(d)) return "エンジニアTM";
  if (/BAA/.test(d)) return "BAA TM";
  if (/AX/.test(d)) return "AXコンサルTM";
  const p = pos ?? "";
  if (/代表取締役/.test(p)) return "代表取締役";
  if (/執行役員/.test(p)) return "執行役員";
  return null;
}

export function LaborSheetTab({ term }: { term: TermCode }) {
  const people = useLaborCostStore((s) => s.people);
  const assignments = useLaborCostStore((s) => s.assignments);
  const amounts = useLaborCostStore((s) => s.amounts);
  const deptMap = useLaborCostStore((s) => s.deptMap);
  const tms = useLaborCostStore((s) => s.tms);
  const applyAmountEdits = useLaborCostStore((s) => s.applyAmountEdits);
  const applyAssignEdits = useLaborCostStore((s) => s.applyAssignEdits);
  const updatePerson = useLaborCostStore((s) => s.updatePerson);
  const undo = useLaborCostStore((s) => s.undo);
  const redo = useLaborCostStore((s) => s.redo);
  const addPerson = useLaborCostStore((s) => s.addPerson);
  const deletePerson = useLaborCostStore((s) => s.deletePerson);
  const setForecastFlag = useLaborCostStore((s) => s.setForecastFlag);
  const saveState = useLaborCostStore((s) => s.saveState);
  const flushNow = useLaborCostStore((s) => s.flushNow);
  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const terms = useLaborCostStore((s) => s.terms);

  const [newName, setNewName] = useState("");
  const [showAll, setShowAll] = useState(true);
  // 退職者を非表示（デフォルトON）。当期に金額計上のある退職者は残す。
  const [hideDeparted, setHideDeparted] = useState(true);
  // 絞り込み: どのQの所属で見るか × 所属 × TM（空=すべて）
  const [filterQ, setFilterQ] = useState<FilterQ>("H1:1");
  const [filterDept, setFilterDept] = useState("");
  const [filterTm, setFilterTm] = useState("");
  // 列の並び替え（ヘッダークリックで 昇順→降順→解除）
  const [sort, setSort] = useState<GridSort | null>(null);
  const [syncing, setSyncing] = useState(false);

  const empByNum = useMemo(
    () => new Map(employees.map((e) => [e.employee_number, e])),
    [employees],
  );

  // 所属プルダウンの選択肢 = 当期の dept_map の所属（＝出力DIV体系）。
  // 兼務先も同じ候補群から選ぶ。
  const deptOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of deptMap) if (m.term === term) set.add(m.dept);
    // 既存割当に dept_map 外の値があれば拾う（移行前の取りこぼし防止）
    for (const a of Object.values(assignments)) {
      if (a.term !== term) continue;
      if (a.dept) set.add(a.dept);
      if (a.kenmu_dept) set.add(a.kenmu_dept);
    }
    return [...set];
  }, [deptMap, assignments, term]);

  // dept（所属）→ DIV。TM列の選択肢を「その人のDIVのTM」だけに絞るために使う。
  const divByDept = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of deptMap) if (d.term === term && d.div) m.set(d.dept, d.div);
    return m;
  }, [deptMap, term]);

  // DIV → そのDIVのTM名（sort_order順）。TMなし設計のDIVは空＝TM列も空になる。
  const tmNamesByDiv = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of [...tms].sort((a, b) => a.sort_order - b.sort_order)) {
      if (!m.has(t.div)) m.set(t.div, []);
      m.get(t.div)!.push(t.tm);
    }
    return m;
  }, [tms]);

  // その行・そのQの所属DIVに属するTMだけを選択肢に出す（クロスDIV誤選択の防止）。
  const tmOptionsFor = (h: Half, q: QuarterPart) => (row: GridRow): string[] => {
    const dept = row.cells[`${h}:${q}:dept`];
    if (typeof dept !== "string" || !dept) return [];
    const div = divByDept.get(dept) ?? dept;
    const list = tmNamesByDiv.get(div) ?? [];
    // 複数TMを持つDIVは「（売上目標比で按分）」を選べる（DIV直下＝どのTMにも属さない人向け）。
    return list.length >= 2 ? [...list, ALLOC_TM] : list;
  };
  // 兼務先TMは兼務先DIVのTMだけに絞る（所属側と同じ考え方）。
  const kenmuTmOptionsFor = (h: Half, q: QuarterPart) => (row: GridRow): string[] => {
    const kdept = row.cells[`${h}:${q}:kenmu`];
    if (typeof kdept !== "string" || !kdept) return [];
    const div = divByDept.get(kdept) ?? kdept;
    return tmNamesByDiv.get(div) ?? [];
  };

  const columns: GridColumn[] = useMemo(() => {
    const quarterCols = (h: Half, q: QuarterPart, label: string): GridColumn[] => [
      { key: `${h}:${q}:dept`, title: "所属", width: 130, type: "select", group: label, options: deptOptions },
      { key: `${h}:${q}:tm`, title: "TM", width: 118, type: "select", group: label, optionsFor: tmOptionsFor(h, q) },
      { key: `${h}:${q}:kenmu`, title: "兼務先", width: 120, type: "select", group: label, options: deptOptions },
      { key: `${h}:${q}:kenmu_tm`, title: "兼務先TM", width: 118, type: "select", group: label, optionsFor: kenmuTmOptionsFor(h, q) },
      { key: `${h}:${q}:rate`, title: "兼務率", width: 64, type: "percent", group: label },
    ];
    const half = (
      h: Half,
      bonusCol: { key: Slot; title: string },
      q1Months: { key: Slot; title: string }[],
      q2Months: { key: Slot; title: string }[],
    ): GridColumn[] => {
      const [label1, label2] = QUARTER_LABEL[h];
      return [
        ...quarterCols(h, 1, label1),
        { key: bonusCol.key, title: bonusCol.title, width: 72, type: "number", group: label1 },
        ...q1Months.map((c): GridColumn => ({
          key: c.key, title: c.title, width: 72, type: "number", group: label1,
        })),
        ...quarterCols(h, 2, label2),
        ...q2Months.map((c): GridColumn => ({
          key: c.key, title: c.title, width: 72, type: "number", group: label2,
        })),
        { key: `${h}:total`, title: h === "H1" ? "上期計" : "下期計", width: 84, type: "readonly", group: label2, align: "right" },
      ];
    };
    return [
      { key: "name", title: "名前", width: 150, type: "readonly", sticky: true },
      { key: "emp_no", title: "社員番号", width: 84, type: "readonly" },
      { key: "hired", title: "入社日", width: 96, type: "text" },
      { key: "master_dept", title: "マスター部署", width: 132, type: "readonly" },
      { key: "master_pos", title: "マスター役職", width: 120, type: "readonly" },
      { key: "master_tm", title: "マスターTM（参考）", width: 120, type: "readonly" },
      ...half("H1", H1_BONUS_COL, H1_Q1_MONTHS, H1_Q2_MONTHS),
      ...half("H2", H2_BONUS_COL, H2_Q1_MONTHS, H2_Q2_MONTHS),
      { key: "y_total", title: "年計", width: 92, type: "readonly", align: "right" },
    ];
  }, [deptOptions, divByDept, tmNamesByDiv]);

  const rows: GridRow[] = useMemo(() => {
    const sorted = [...people].sort((a, b) => a.sort_order - b.sort_order);
    const out: GridRow[] = [];
    for (const p of sorted) {
      // 未連携かつ手動でない行（旧退職者等のノイズ）は非表示（req: 社員でないため除く）
      if (!p.employee_number && !p.is_manual) continue;
      const a1q1 = assignments[assignKey(p.id, term, "H1", 1)];
      const a1q2 = assignments[assignKey(p.id, term, "H1", 2)];
      const a2q1 = assignments[assignKey(p.id, term, "H2", 1)];
      const a2q2 = assignments[assignKey(p.id, term, "H2", 2)];
      const emp = p.employee_number ? empByNum.get(p.employee_number) : null;
      // 万円で0は「無データ」＝空欄扱い（スプシ挙動）。Deleteで0が残っても空表示。
      const amt = (slot: Slot) => {
        const v = amounts[amountKey(p.id, term, slot)]?.amount;
        return v ? v : null;
      };
      let h1 = 0; let h2 = 0; let hasData = false;
      const baseName = (emp?.display_name || emp?.full_name || p.name) ?? p.name;
      const cells: GridRow["cells"] = {
        name:
          baseName +
          (p.departed ? "（退職）" : "") +
          (p.is_manual ? "（見立て）" : !p.employee_number ? "（未連携）" : ""),
        emp_no: p.employee_number ?? (p.is_manual ? "手動" : "—"),
        hired: p.hired_at,
        master_dept: emp?.department ?? (p.employee_number ? "—" : ""),
        master_pos: emp?.position_title ?? (p.employee_number ? "—" : ""),
        master_tm: parseMasterTm(emp?.department, emp?.position_title) ?? (p.employee_number ? "—" : ""),
        "H1:1:dept": a1q1?.dept ?? null,
        "H1:1:tm": a1q1?.tm ?? null,
        "H1:1:kenmu": a1q1?.kenmu_dept ?? null,
        "H1:1:kenmu_tm": a1q1?.kenmu_tm ?? null,
        "H1:1:rate": a1q1?.kenmu_rate ? a1q1.kenmu_rate : null,
        "H1:2:dept": a1q2?.dept ?? null,
        "H1:2:tm": a1q2?.tm ?? null,
        "H1:2:kenmu": a1q2?.kenmu_dept ?? null,
        "H1:2:kenmu_tm": a1q2?.kenmu_tm ?? null,
        "H1:2:rate": a1q2?.kenmu_rate ? a1q2.kenmu_rate : null,
        "H2:1:dept": a2q1?.dept ?? null,
        "H2:1:tm": a2q1?.tm ?? null,
        "H2:1:kenmu": a2q1?.kenmu_dept ?? null,
        "H2:1:kenmu_tm": a2q1?.kenmu_tm ?? null,
        "H2:1:rate": a2q1?.kenmu_rate ? a2q1.kenmu_rate : null,
        "H2:2:dept": a2q2?.dept ?? null,
        "H2:2:tm": a2q2?.tm ?? null,
        "H2:2:kenmu": a2q2?.kenmu_dept ?? null,
        "H2:2:kenmu_tm": a2q2?.kenmu_tm ?? null,
        "H2:2:rate": a2q2?.kenmu_rate ? a2q2.kenmu_rate : null,
      };
      for (const c of H1_AMOUNT_COLS) {
        const v = amt(c.key);
        cells[c.key] = v;
        if (v != null) { h1 += v; hasData = true; }
      }
      for (const c of H2_AMOUNT_COLS) {
        const v = amt(c.key);
        cells[c.key] = v;
        if (v != null) { h2 += v; hasData = true; }
      }
      cells["H1:total"] = hasData ? h1 : null;
      cells["H2:total"] = hasData ? h2 : null;
      cells["y_total"] = hasData ? h1 + h2 : null;
      // 退職者非表示: 当期（上期＋下期）で計上ゼロの退職者のみ隠す。
      // 例: 10月退社は上期計上あり→hasData=true→残る。
      if (hideDeparted && p.departed && !hasData) continue;
      if (!showAll && !hasData && !a1q1 && !a1q2 && !a2q1 && !a2q2) continue;
      // 絞り込み（選択Qの所属・TMで判定）
      if (filterDept) {
        const [fh, fq] = filterQ.split(":");
        if (cells[`${fh}:${fq}:dept`] !== filterDept) continue;
        if (filterTm) {
          const tmv = cells[`${fh}:${fq}:tm`] ?? null;
          if (filterTm === UNASSIGNED_FILTER ? tmv != null : tmv !== filterTm) continue;
        }
      }
      out.push({
        id: p.id,
        cells,
        className: p.departed ? "lg-departed" : undefined,
      });
    }
    if (sort) {
      const dir = sort.dir === "asc" ? 1 : -1;
      out.sort((a, b) => {
        const va = a.cells[sort.key] ?? null;
        const vb = b.cells[sort.key] ?? null;
        // 空欄は昇順・降順どちらでも末尾
        if (va == null || va === "") return vb == null || vb === "" ? 0 : 1;
        if (vb == null || vb === "") return -1;
        if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
        return String(va).localeCompare(String(vb), "ja", { numeric: true }) * dir;
      });
    }
    // 合計行は絞り込み後の表示行だけを足す
    const colTotals: Record<string, number> = {};
    for (const r of out) {
      for (const k of TOTAL_KEYS) {
        const v = r.cells[k];
        if (typeof v === "number") colTotals[k] = (colTotals[k] ?? 0) + v;
      }
    }
    out.push({
      id: TOTAL_ROW_ID,
      cells: { name: `合計（${out.length}名）`, ...colTotals },
      className: "lg-total-row",
    });
    return out;
  }, [people, assignments, amounts, term, showAll, hideDeparted, empByNum, filterQ, filterDept, filterTm, sort]);

  // 絞り込みの選択肢: 所属＝当期の dept 候補／TM＝選んだ所属DIVのTM＋未割当
  const filterTmOptions = useMemo(() => {
    if (!filterDept) return [];
    const div = divByDept.get(filterDept) ?? filterDept;
    const list = tmNamesByDiv.get(div) ?? [];
    return list.length > 0 ? [...list, ...(list.length >= 2 ? [ALLOC_TM] : []), UNASSIGNED_FILTER] : [];
  }, [filterDept, divByDept, tmNamesByDiv]);

  const onHeaderClick = (key: string) => {
    setSort((cur) =>
      !cur || cur.key !== key
        ? { key, dir: "asc" }
        : cur.dir === "asc"
          ? { key, dir: "desc" }
          : null,
    );
  };

  // TalentHub 従業員マスターとの同期:
  //   ①マスターにいるが人件費シートに無い人を追加（アルバイト・パートは対象外）
  //   ②同名の見立て行（手動）があれば新規追加せず社員番号を紐づけ
  //   ③連携済みメンバーの入社日・退職フラグをマスターに合わせる
  const syncFromMaster = async () => {
    setSyncing(true);
    try {
      await refreshEmployees({ silent: true });
      const emps = useEmployeesStore.getState().employees;
      const linked = new Set(people.map((p) => p.employee_number).filter(Boolean));
      const termRow = terms.find((t) => t.code === term);
      const termStart = termRow ? `${termRow.start_year}-07-01` : "0000-01-01";
      const today = new Date().toISOString().slice(0, 10);
      const norm = (s: string | null | undefined) => (s ?? "").replace(/[\s\u3000]/g, "");
      const manual = people.filter((p) => p.is_manual && !p.employee_number);
      const toLink: { personId: string; label: string; emp: (typeof emps)[number] }[] = [];
      const toAdd: (typeof emps)[number][] = [];
      for (const e of emps) {
        if (!e.employee_number || linked.has(e.employee_number)) continue;
        if (/アルバイト|パート/.test(e.employment_type ?? "")) continue;
        if (e.left_at && e.left_at < termStart) continue; // 当期より前の退職者は不要
        const full = norm(e.full_name);
        const disp = norm(e.display_name);
        const m = manual.find((p) => {
          const n = norm(p.name);
          return n && (n === full || n === disp || (full.startsWith(n) && n.length >= 2));
        });
        if (m) toLink.push({ personId: m.id, label: `${m.name} → ${e.full_name}（${e.employee_number}）`, emp: e });
        else toAdd.push(e);
      }
      const toUpdate: { id: string; label: string; patch: { hired_at?: string | null; departed?: boolean } }[] = [];
      for (const p of people) {
        if (!p.employee_number) continue;
        const e = emps.find((x) => x.employee_number === p.employee_number);
        if (!e) continue;
        const patch: { hired_at?: string | null; departed?: boolean } = {};
        if (e.hired_at && e.hired_at !== p.hired_at) patch.hired_at = e.hired_at;
        const departed = !!e.left_at && e.left_at < today;
        if (departed !== p.departed) patch.departed = departed;
        if (Object.keys(patch).length > 0) {
          toUpdate.push({
            id: p.id,
            label: `${e.full_name}: ` +
              [patch.hired_at ? `入社日 ${patch.hired_at}` : "", patch.departed != null ? (patch.departed ? "退職に変更" : "在籍に変更") : ""]
                .filter(Boolean).join("・"),
            patch,
          });
        }
      }
      if (toAdd.length + toLink.length + toUpdate.length === 0) {
        alert("従業員マスターと差分はありませんでした。");
        return;
      }
      const lines = [
        toAdd.length ? `■ 追加 ${toAdd.length}名\n` + toAdd.map((e) => `・${e.full_name}（${e.employee_number}／${e.employment_type ?? "—"}／入社 ${e.hired_at ?? "—"}）`).join("\n") : "",
        toLink.length ? `■ 見立て行を社員に紐づけ ${toLink.length}名\n` + toLink.map((x) => `・${x.label}`).join("\n") : "",
        toUpdate.length ? `■ 入社日・退職の更新 ${toUpdate.length}名\n` + toUpdate.map((x) => `・${x.label}`).join("\n") : "",
      ].filter(Boolean);
      if (!window.confirm(`従業員マスターと同期します（アルバイト・パートは対象外）。\n\n${lines.join("\n\n")}\n\n追加した人の所属・金額は空欄で入ります。よろしいですか？`)) return;
      for (const e of toAdd) {
        await addPerson(e.full_name ?? e.employee_number, {
          employee_number: e.employee_number,
          hired_at: e.hired_at,
          departed: !!e.left_at && e.left_at < today,
        });
      }
      for (const x of toLink) {
        await updatePerson(x.personId, {
          employee_number: x.emp.employee_number,
          hired_at: x.emp.hired_at ?? null,
          is_manual: false,
        });
      }
      for (const x of toUpdate) await updatePerson(x.id, x.patch);
      alert(`同期しました（追加 ${toAdd.length}名・紐づけ ${toLink.length}名・更新 ${toUpdate.length}名）`);
    } finally {
      setSyncing(false);
    }
  };

  const onEdits = (edits: GridEdit[], label: string) => {
    const amountEdits: { personId: string; term: TermCode; slot: Slot; amount: number }[] = [];
    const assignEdits: Parameters<typeof applyAssignEdits>[0] = [];
    const peopleById = new Map(people.map((p) => [p.id, p]));
    for (const e of edits) {
      if (e.rowId === TOTAL_ROW_ID) continue;
      if (!peopleById.has(e.rowId)) continue;
      if (AMOUNT_KEYS.has(e.colKey)) {
        amountEdits.push({
          personId: e.rowId,
          term,
          slot: e.colKey as Slot,
          amount: e.value == null ? 0 : Number(e.value) || 0,
        });
        continue;
      }
      if (e.colKey === "hired") {
        void updatePerson(e.rowId, {
          hired_at: e.value == null ? null : String(e.value),
        });
        continue;
      }
      const [half, qStr, field] = e.colKey.split(":") as [Half, string, string];
      const quarter = (Number(qStr) as QuarterPart) === 2 ? 2 : 1;
      if (field === "dept") {
        const newDept = e.value == null ? null : String(e.value);
        // 所属変更で旧TMが新DIVに属さなくなる場合は同じ編集内でTMも自動クリア
        // （誤ルーティング防止／dept・tmは1編集にまとめる＝別編集にすると元値独立計算でdeptが失われる）。
        const patch: Parameters<typeof applyAssignEdits>[0][number] = { personId: e.rowId, term, half, quarter, dept: newDept };
        const curTm = assignments[assignKey(e.rowId, term, half, quarter)]?.tm ?? null;
        if (curTm) {
          const newDiv = newDept ? (divByDept.get(newDept) ?? newDept) : null;
          const allowed = newDiv ? tmNamesByDiv.get(newDiv) ?? [] : [];
          // 按分(ALLOC)は複数TMのDIVなら移動後も有効なので維持。それ以外は新DIVに無いTMをクリア。
          const stillValid =
            allowed.includes(curTm) || (curTm === ALLOC_TM && allowed.length >= 2);
          if (!stillValid) patch.tm = null;
        }
        assignEdits.push(patch);
      }
      else if (field === "tm") assignEdits.push({ personId: e.rowId, term, half, quarter, tm: e.value == null ? null : String(e.value) });
      else if (field === "kenmu") {
        const newKenmu = e.value == null ? null : String(e.value);
        const patch: Parameters<typeof applyAssignEdits>[0][number] = { personId: e.rowId, term, half, quarter, kenmu_dept: newKenmu };
        // 兼務先変更で旧兼務先TMが新兼務先DIVに属さなくなる場合は同編集内でクリア。
        const curKtm = assignments[assignKey(e.rowId, term, half, quarter)]?.kenmu_tm ?? null;
        if (curKtm) {
          const newDiv = newKenmu ? (divByDept.get(newKenmu) ?? newKenmu) : null;
          const allowed = newDiv ? tmNamesByDiv.get(newDiv) ?? [] : [];
          if (!allowed.includes(curKtm)) patch.kenmu_tm = null;
        }
        assignEdits.push(patch);
      }
      else if (field === "kenmu_tm") assignEdits.push({ personId: e.rowId, term, half, quarter, kenmu_tm: e.value == null ? null : String(e.value) });
      else if (field === "rate") assignEdits.push({ personId: e.rowId, term, half, quarter, kenmu_rate: e.value == null ? 0 : Number(e.value) || 0 });
    }
    if (amountEdits.length > 0) applyAmountEdits(amountEdits, label);
    if (assignEdits.length > 0) applyAssignEdits(assignEdits, label);
  };

  const cellClassName = (rowId: string, colKey: string): string | undefined => {
    if (!AMOUNT_KEYS.has(colKey)) return undefined;
    const a = amounts[amountKey(rowId, term, colKey as Slot)];
    return a?.is_forecast ? "lg-forecast" : undefined;
  };

  const forecastCount = useMemo(
    () =>
      Object.values(amounts).filter((a) => a.term === term && a.is_forecast).length,
    [amounts, term],
  );

  // 1Q（3Q）の所属・TM・兼務設定を、全員の2Q（4Q）へ一括コピーする
  // （ほとんどの従業員は1Q=2Qのため。個別に異動がある人だけ後から2Q単体を編集する）。
  const copyQuarterToSecond = (half: Half) => {
    const [q1Label, q2Label] = QUARTER_LABEL[half];
    if (
      !window.confirm(
        `${q1Label}の所属・TM・兼務先・兼務率を、全員の${q2Label}へ上書きコピーします。` +
          `すでに${q2Label}を個別に設定している人の値も上書きされます。よろしいですか？`,
      )
    ) {
      return;
    }
    const copyEdits: Parameters<typeof applyAssignEdits>[0] = [];
    for (const p of people) {
      const a1 = assignments[assignKey(p.id, term, half, 1)];
      if (!a1) continue;
      copyEdits.push({
        personId: p.id, term, half, quarter: 2,
        dept: a1.dept, kenmu_dept: a1.kenmu_dept, kenmu_rate: a1.kenmu_rate,
        tm: a1.tm, kenmu_tm: a1.kenmu_tm,
      });
    }
    if (copyEdits.length > 0) applyAssignEdits(copyEdits, `${q1Label}→${q2Label} 一括コピー`);
  };

  // 手動（見立て）行＝マスター未登録・削除可
  const manualRows = useMemo(
    () => people.filter((p) => p.is_manual && !p.employee_number),
    [people],
  );
  const onDeleteManual = (id: string, name: string) => {
    if (!window.confirm(`見立て行「${name}」を削除します。金額・所属も一緒に削除されます。よろしいですか？`)) return;
    void deletePerson(id).then((r) => {
      if (!r.ok) alert(`削除できませんでした: ${r.reason ?? "不明なエラー"}`);
    });
  };

  const departedHiddenCount = useMemo(() => {
    if (!hideDeparted) return 0;
    let n = 0;
    for (const p of people) {
      if (!p.departed) continue;
      const has =
        [...H1_AMOUNT_COLS, ...H2_AMOUNT_COLS].some(
          (c) => (amounts[amountKey(p.id, term, c.key)]?.amount ?? 0) !== 0,
        );
      if (!has) n++;
    }
    return n;
  }, [people, amounts, term, hideDeparted]);

  return (
    <div className="labor-sheet">
      <div className="labor-toolbar">
        <div className="labor-savebar">
          <button
            className="labor-btn labor-btn--save"
            onClick={() => void flushNow()}
            disabled={saveState === "saving"}
            title="編集は自動保存されますが、今すぐ確定保存します"
          >
            💾 変更を保存
          </button>
          <span
            className={
              "labor-savestate" +
              (saveState === "error" ? " labor-savestate--error" : "") +
              (saveState === "idle" ? " labor-savestate--ok" : "")
            }
          >
            {saveState === "error"
              ? "⚠ 保存エラー（自動再試行中）"
              : saveState === "saving"
                ? "保存中…"
                : saveState === "pending"
                  ? "● 未保存の変更があります"
                  : "✓ すべて保存済み"}
          </span>
        </div>
        <label className="labor-check">
          <input
            type="checkbox"
            checked={hideDeparted}
            onChange={(e) => setHideDeparted(e.target.checked)}
          />
          退職者を非表示（当期に計上のある退職者は残す
          {departedHiddenCount > 0 ? `・${departedHiddenCount}名を非表示中` : ""}）
        </label>
        <label className="labor-check">
          <input
            type="checkbox"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
          />
          この期にデータのない人も表示
        </label>
        <button
          className="labor-btn"
          onClick={() => void syncFromMaster()}
          disabled={syncing}
          title="TalentHub の従業員マスターから、未登録の社員（アルバイト・パート除く）の追加と入社日・退職の更新を行います"
        >
          {syncing ? "同期中…" : "⟳ 従業員マスターと同期"}
        </button>
        <button className="labor-btn" onClick={() => copyQuarterToSecond("H1")}>
          1Q→2Q 一括コピー
        </button>
        <button className="labor-btn" onClick={() => copyQuarterToSecond("H2")}>
          3Q→4Q 一括コピー
        </button>
        {term === "5" && (
          <div className="labor-forecast-ctl">
            <span className="lg-forecast labor-forecast-chip">見込み</span>
            {forecastCount > 0 ? (
              <>
                <span>下期は見立て数字（{forecastCount}セル）</span>
                <button
                  className="labor-btn"
                  onClick={() => void setForecastFlag("5", "H2", false)}
                >
                  下期を確定に切替
                </button>
              </>
            ) : (
              <button
                className="labor-btn"
                onClick={() => void setForecastFlag("5", "H2", true)}
              >
                下期を見込みに戻す
              </button>
            )}
          </div>
        )}
        <div className="labor-addperson">
          <input
            placeholder="見立て行の名前（手動追加）"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                void addPerson(newName).then(() => setNewName(""));
              }
            }}
          />
          <button
            className="labor-btn"
            disabled={!newName.trim()}
            onClick={() => void addPerson(newName).then(() => setNewName(""))}
          >
            ＋ 見立て行を追加
          </button>
        </div>
      </div>
      <div className="labor-filterbar">
        <span className="labor-filterbar-label">絞り込み</span>
        <select value={filterQ} onChange={(e) => setFilterQ(e.target.value as FilterQ)} title="どのQの所属で絞り込むか">
          {(Object.keys(FILTER_Q_LABEL) as FilterQ[]).map((q) => (
            <option key={q} value={q}>{FILTER_Q_LABEL[q]}</option>
          ))}
        </select>
        <select
          value={filterDept}
          onChange={(e) => { setFilterDept(e.target.value); setFilterTm(""); }}
          title="所属"
        >
          <option value="">所属：すべて</option>
          {deptOptions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <select
          value={filterTm}
          onChange={(e) => setFilterTm(e.target.value)}
          disabled={filterTmOptions.length === 0}
          title="TM（所属を選ぶと選べます）"
        >
          <option value="">TM：すべて</option>
          {filterTmOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {(filterDept || sort) && (
          <button className="labor-btn" onClick={() => { setFilterDept(""); setFilterTm(""); setSort(null); }}>
            絞り込み・並び替えを解除
          </button>
        )}
        <span className="labor-filterbar-hint">列名クリックで 昇順 → 降順 → 解除</span>
      </div>
      {manualRows.length > 0 && (
        <div className="labor-manualbar">
          <span className="labor-manualbar-label">見立て行（手動・削除可）:</span>
          {manualRows.map((p) => (
            <span key={p.id} className="labor-manualchip">
              {p.name}
              <button
                className="labor-manualdel"
                title="この見立て行を削除"
                onClick={() => onDeleteManual(p.id, p.name)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <LaborGrid
        columns={columns}
        rows={rows}
        onEdits={onEdits}
        onUndo={undo}
        onRedo={redo}
        cellClassName={cellClassName}
        sort={sort}
        onHeaderClick={onHeaderClick}
      />
      <p className="labor-hint">
        名前・社員番号・入社日・マスター所属・マスターTM（参考）は従業員マスター（社員番号で突合）から表示。
        所属（DIV）とTMは「マスター所属／マスターTM」を見ながらプルダウンで確定します。
        TM・兼務先TMの選択肢は、その行の所属DIV／兼務先DIVのTMだけに絞られます
        （TMなし設計のDIV＝HR/開発/コーポ/フロント等はTM列が空＝DIV直計上）。
        コピー/ペースト（⌘C/⌘V）・⌘Z 取り消し・⌘D フィルダウン・Delete クリア。金額は万円。
        兼務率は所属から差し引く率（50% → 所属50%/兼務先50%。兼務先が
        空欄の場合、その分はどの部署にも計上しない＝元シート仕様）。
        上期は1Q（7〜9月）/2Q（10〜12月）、下期は3Q（1〜3月）/4Q（4〜6月）に分けて所属を持てます。
        ほとんどの人は1Q=2Q（3Q=4Q）で同じ値のままでOK。期中で人事異動があった人だけ、
        異動後のQの所属・TM・兼務先を個別に書き換えてください（変更前後で計上組織が切り替わり、
        7〜9月・10〜12月それぞれの実額がその時点の所属へ計上されます。夏ボ/冬ボはこれまでどおり
        半期÷6を維持したまま、月数に応じて自然に両方の所属へ按分されます）。
        「1Q→2Q 一括コピー」「3Q→4Q 一括コピー」で全員分をまず複製し、異動者だけ後から個別修正すると楽です。
      </p>
    </div>
  );
}
