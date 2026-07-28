import { useMemo, useState } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { LaborGrid } from "./LaborGrid";
import type { GridColumn, GridEdit, GridRow } from "./LaborGrid";
import type { Half, Slot, TermCode } from "../../lib/laborCost";
import { amountKey, assignKey, ALLOC_TM } from "../../lib/laborCost";

/**
 * 個人別シート: 元スプレッドシート「人件費ローデータ」と同じ列構成を
 * 期ごとに表示・編集する。
 * 列: 名前 | 社員番号 | 入社日 | マスター所属
 *    | 上期(所属/兼務先/兼務率/夏ボ/7〜12月/上期計)
 *    | 下期(所属/兼務先/兼務率/冬ボ/1〜6月/下期計) | 年計
 *
 * 名前・社員番号・入社日・マスター所属は TalentHub 従業員マスター(employees)と
 * employee_number で突合して表示する。所属(DIV)は「マスター所属」を候補として
 * 見ながらプルダウンで手動確定する（マスターの単一部署文字列は自動分離不可）。
 */

const H1_AMOUNT_COLS: { key: Slot; title: string }[] = [
  { key: "BS", title: "夏ボ" },
  { key: "7", title: "7月" },
  { key: "8", title: "8月" },
  { key: "9", title: "9月" },
  { key: "10", title: "10月" },
  { key: "11", title: "11月" },
  { key: "12", title: "12月" },
];
const H2_AMOUNT_COLS: { key: Slot; title: string }[] = [
  { key: "BW", title: "冬ボ" },
  { key: "1", title: "1月" },
  { key: "2", title: "2月" },
  { key: "3", title: "3月" },
  { key: "4", title: "4月" },
  { key: "5", title: "5月" },
  { key: "6", title: "6月" },
];

const AMOUNT_KEYS = new Set<string>([
  ...H1_AMOUNT_COLS.map((c) => c.key),
  ...H2_AMOUNT_COLS.map((c) => c.key),
]);

const TOTAL_ROW_ID = "__total__";

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

  const [newName, setNewName] = useState("");
  const [showAll, setShowAll] = useState(true);
  // 退職者を非表示（デフォルトON）。当期に金額計上のある退職者は残す。
  const [hideDeparted, setHideDeparted] = useState(true);

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

  // その行・その半期の所属DIVに属するTMだけを選択肢に出す（クロスDIV誤選択の防止）。
  const tmOptionsFor = (h: Half) => (row: GridRow): string[] => {
    const dept = row.cells[`${h}:dept`];
    if (typeof dept !== "string" || !dept) return [];
    const div = divByDept.get(dept) ?? dept;
    const list = tmNamesByDiv.get(div) ?? [];
    // 複数TMを持つDIVは「（売上目標比で按分）」を選べる（DIV直下＝どのTMにも属さない人向け）。
    return list.length >= 2 ? [...list, ALLOC_TM] : list;
  };
  // 兼務先TMは兼務先DIVのTMだけに絞る（所属側と同じ考え方）。
  const kenmuTmOptionsFor = (h: Half) => (row: GridRow): string[] => {
    const kdept = row.cells[`${h}:kenmu`];
    if (typeof kdept !== "string" || !kdept) return [];
    const div = divByDept.get(kdept) ?? kdept;
    return tmNamesByDiv.get(div) ?? [];
  };

  const columns: GridColumn[] = useMemo(() => {
    const half = (h: Half, label: string, amountCols: { key: Slot; title: string }[]): GridColumn[] => [
      { key: `${h}:dept`, title: `${h === "H1" ? "上期" : "下期"}所属`, width: 130, type: "select", group: label, options: deptOptions },
      { key: `${h}:tm`, title: "TM", width: 118, type: "select", group: label, optionsFor: tmOptionsFor(h) },
      { key: `${h}:kenmu`, title: "兼務先", width: 120, type: "select", group: label, options: deptOptions },
      { key: `${h}:kenmu_tm`, title: "兼務先TM", width: 118, type: "select", group: label, optionsFor: kenmuTmOptionsFor(h) },
      { key: `${h}:rate`, title: "兼務率", width: 64, type: "percent", group: label },
      ...amountCols.map((c): GridColumn => ({
        key: c.key, title: c.title, width: 72, type: "number", group: label,
      })),
      { key: `${h}:total`, title: h === "H1" ? "上期計" : "下期計", width: 84, type: "readonly", group: label, align: "right" },
    ];
    return [
      { key: "name", title: "名前", width: 150, type: "readonly", sticky: true },
      { key: "emp_no", title: "社員番号", width: 84, type: "readonly" },
      { key: "hired", title: "入社日", width: 96, type: "text" },
      { key: "master_dept", title: "マスター部署", width: 132, type: "readonly" },
      { key: "master_pos", title: "マスター役職", width: 120, type: "readonly" },
      { key: "master_tm", title: "マスターTM（参考）", width: 120, type: "readonly" },
      ...half("H1", "上期（7〜12月）", H1_AMOUNT_COLS),
      ...half("H2", "下期（1〜6月）", H2_AMOUNT_COLS),
      { key: "y_total", title: "年計", width: 92, type: "readonly", align: "right" },
    ];
  }, [deptOptions, divByDept, tmNamesByDiv]);

  const rows: GridRow[] = useMemo(() => {
    const sorted = [...people].sort((a, b) => a.sort_order - b.sort_order);
    const out: GridRow[] = [];
    const colTotals: Record<string, number> = {};
    for (const p of sorted) {
      // 未連携かつ手動でない行（旧退職者等のノイズ）は非表示（req: 社員でないため除く）
      if (!p.employee_number && !p.is_manual) continue;
      const a1 = assignments[assignKey(p.id, term, "H1")];
      const a2 = assignments[assignKey(p.id, term, "H2")];
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
        "H1:dept": a1?.dept ?? null,
        "H1:tm": a1?.tm ?? null,
        "H1:kenmu": a1?.kenmu_dept ?? null,
        "H1:kenmu_tm": a1?.kenmu_tm ?? null,
        "H1:rate": a1?.kenmu_rate ? a1.kenmu_rate : null,
        "H2:dept": a2?.dept ?? null,
        "H2:tm": a2?.tm ?? null,
        "H2:kenmu": a2?.kenmu_dept ?? null,
        "H2:kenmu_tm": a2?.kenmu_tm ?? null,
        "H2:rate": a2?.kenmu_rate ? a2.kenmu_rate : null,
      };
      for (const c of H1_AMOUNT_COLS) {
        const v = amt(c.key);
        cells[c.key] = v;
        if (v != null) { h1 += v; hasData = true; colTotals[c.key] = (colTotals[c.key] ?? 0) + v; }
      }
      for (const c of H2_AMOUNT_COLS) {
        const v = amt(c.key);
        cells[c.key] = v;
        if (v != null) { h2 += v; hasData = true; colTotals[c.key] = (colTotals[c.key] ?? 0) + v; }
      }
      cells["H1:total"] = hasData ? h1 : null;
      cells["H2:total"] = hasData ? h2 : null;
      cells["y_total"] = hasData ? h1 + h2 : null;
      if (hasData) {
        colTotals["H1:total"] = (colTotals["H1:total"] ?? 0) + h1;
        colTotals["H2:total"] = (colTotals["H2:total"] ?? 0) + h2;
        colTotals["y_total"] = (colTotals["y_total"] ?? 0) + h1 + h2;
      }
      // 退職者非表示: 当期（上期＋下期）で計上ゼロの退職者のみ隠す。
      // 例: 10月退社は上期計上あり→hasData=true→残る。
      if (hideDeparted && p.departed && !hasData) continue;
      if (!showAll && !hasData && !a1 && !a2) continue;
      out.push({
        id: p.id,
        cells,
        className: p.departed ? "lg-departed" : undefined,
      });
    }
    out.push({
      id: TOTAL_ROW_ID,
      cells: { name: "合計", ...colTotals },
      className: "lg-total-row",
    });
    return out;
  }, [people, assignments, amounts, term, showAll, hideDeparted, empByNum]);

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
      const [half, field] = e.colKey.split(":") as [Half, string];
      if (field === "dept") {
        const newDept = e.value == null ? null : String(e.value);
        // 所属変更で旧TMが新DIVに属さなくなる場合は同じ編集内でTMも自動クリア
        // （誤ルーティング防止／dept・tmは1編集にまとめる＝別編集にすると元値独立計算でdeptが失われる）。
        const patch: Parameters<typeof applyAssignEdits>[0][number] = { personId: e.rowId, term, half, dept: newDept };
        const curTm = assignments[assignKey(e.rowId, term, half)]?.tm ?? null;
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
      else if (field === "tm") assignEdits.push({ personId: e.rowId, term, half, tm: e.value == null ? null : String(e.value) });
      else if (field === "kenmu") {
        const newKenmu = e.value == null ? null : String(e.value);
        const patch: Parameters<typeof applyAssignEdits>[0][number] = { personId: e.rowId, term, half, kenmu_dept: newKenmu };
        // 兼務先変更で旧兼務先TMが新兼務先DIVに属さなくなる場合は同編集内でクリア。
        const curKtm = assignments[assignKey(e.rowId, term, half)]?.kenmu_tm ?? null;
        if (curKtm) {
          const newDiv = newKenmu ? (divByDept.get(newKenmu) ?? newKenmu) : null;
          const allowed = newDiv ? tmNamesByDiv.get(newDiv) ?? [] : [];
          if (!allowed.includes(curKtm)) patch.kenmu_tm = null;
        }
        assignEdits.push(patch);
      }
      else if (field === "kenmu_tm") assignEdits.push({ personId: e.rowId, term, half, kenmu_tm: e.value == null ? null : String(e.value) });
      else if (field === "rate") assignEdits.push({ personId: e.rowId, term, half, kenmu_rate: e.value == null ? 0 : Number(e.value) || 0 });
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

  // 連携済みメンバーの入社日をマスター(hired_at)から一括取込。
  const syncHiredFromMaster = () => {
    let n = 0;
    for (const p of people) {
      if (!p.employee_number) continue;
      const emp = empByNum.get(p.employee_number);
      if (emp?.hired_at && emp.hired_at !== p.hired_at) {
        void updatePerson(p.id, { hired_at: emp.hired_at });
        n++;
      }
    }
    alert(
      n > 0
        ? `${n}名の入社日をマスターから取り込みました`
        : "マスターと差異のある入社日はありませんでした（連携済みのみ対象）",
    );
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
        <button className="labor-btn" onClick={syncHiredFromMaster}>
          入社日をマスターから取込
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
      />
      <p className="labor-hint">
        名前・社員番号・入社日・マスター所属・マスターTM（参考）は従業員マスター（社員番号で突合）から表示。
        所属（DIV）とTMは「マスター所属／マスターTM」を見ながらプルダウンで確定します。
        TM・兼務先TMの選択肢は、その行の所属DIV／兼務先DIVのTMだけに絞られます
        （TMなし設計のDIV＝HR/開発/コーポ/フロント等はTM列が空＝DIV直計上）。
        コピー/ペースト（⌘C/⌘V）・⌘Z 取り消し・⌘D フィルダウン・Delete クリア。金額は万円。
        兼務率は所属から差し引く率（50% → 所属50%/兼務先50%。兼務先が
        空欄の場合、その分はどの部署にも計上しない＝元シート仕様）。
      </p>
    </div>
  );
}
