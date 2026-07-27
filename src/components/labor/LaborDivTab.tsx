import { useMemo, useState, type ReactElement } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import type { Half, HalfComputation, TermCode } from "../../lib/laborCost";
import { computeHalf, fmtMan } from "../../lib/laborCost";

/**
 * DIV別 月次按分ビュー（読み取り専用・自動計算）。
 * - メンバー月次給与（兼務率で分割計上）
 * - ボーナス按分値（半期ボーナス ÷ 6）
 * - 社会保険料（(給与+ボーナス按分) × 率）
 * - フロント人件費: DIV別売上目標比率（半期固定）で按分
 * - コーポレート: 按分対象外・独立表示
 */

export function LaborDivTab({ term }: { term: TermCode }) {
  const store = useLaborCostStore();
  const [half, setHalf] = useState<Half>("H1");

  const termRow = store.terms.find((t) => t.code === term);

  const comp: HalfComputation | null = useMemo(() => {
    if (!termRow) return null;
    return computeHalf({
      term: termRow,
      half,
      people: store.people,
      assignments: store.assignments,
      amounts: store.amounts,
      deptMap: store.deptMap,
      tms: store.tms,
      frontTargets: store.frontTargets,
      insuranceRate: store.insuranceRate,
    });
  }, [termRow, half, store.people, store.assignments, store.amounts, store.deptMap, store.tms, store.frontTargets, store.insuranceRate]);

  if (!termRow || !comp) return null;

  const months = comp.months;
  const yearOf = () =>
    half === "H1" ? termRow.start_year : termRow.start_year + 1;
  const sum = (rec: Record<string, number>) =>
    months.reduce((s, m) => s + (rec[m] ?? 0), 0);

  const Num = ({ v, strong }: { v: number; strong?: boolean }) => (
    <td className={"labor-num" + (strong ? " labor-strong" : "")}>{fmtMan(v)}</td>
  );

  const MonthCells = ({ rec, strong }: { rec: Record<string, number>; strong?: boolean }) => (
    <>
      {months.map((m) => (
        <Num key={m} v={rec[m] ?? 0} strong={strong} />
      ))}
      <Num v={sum(rec)} strong />
    </>
  );

  return (
    <div className="labor-div">
      <div className="labor-toolbar">
        <div className="labor-halfswitch">
          <button
            className={"labor-btn" + (half === "H1" ? " labor-btn--on" : "")}
            onClick={() => setHalf("H1")}
          >
            上期（{termRow.start_year}/7〜12）
          </button>
          <button
            className={"labor-btn" + (half === "H2" ? " labor-btn--on" : "")}
            onClick={() => setHalf("H2")}
          >
            下期（{termRow.start_year + 1}/1〜6）
          </button>
        </div>
        <span className="labor-note">
          社保 {Math.round(store.insuranceRate * 1000) / 10}% ／ ボーナスは半期6ヶ月按分 ／
          フロントは売上目標比按分（
          {Object.entries(comp.frontRatios)
            .map(([d, r]) => `${d.replace(/_?DIv|_?Div/g, "")} ${Math.round(r * 1000) / 10}%`)
            .join("・")}
          ）
        </span>
      </div>

      {comp.unmappedDepts.length > 0 && (
        <div className="labor-warn">
          ⚠ マッピング未定義の所属があります: {comp.unmappedDepts.join("、")}
          （設定タブで labor_dept_map を確認してください。未定義分は集計から漏れています）
        </div>
      )}

      {comp.frontUnallocated && (
        <div className="labor-warn">
          ⚠ フロント人件費を各DIVへ按分し切れていません（売上目標が未登録/0、または目標DIVがTM一覧に無い可能性）。
          残差 {fmtMan(months.reduce((s, m) => s + (comp.frontUnallocatedByMonth[m] ?? 0), 0))}万円/半期は
          全社総計には加算していますが、DIV別には配分されていません。設定タブの売上目標を確認してください。
        </div>
      )}

      <table className="labor-divtable">
        <thead>
          <tr>
            <th className="labor-head-item">項目</th>
            {months.map((m) => (
              <th key={m}>
                {yearOf()}/{m}
              </th>
            ))}
            <th>半期計</th>
          </tr>
        </thead>
        <tbody>
          {comp.divs.map((d) => (
            <DivBlock key={d.div} d={d} MonthCells={MonthCells} />
          ))}

          {/* フロント原資（各DIVへ売上目標比で按分・下の按分行が各DIVの受け分） */}
          <tr className="labor-divhead">
            <td>フロントDIV（按分原資）</td>
            <MonthCells rec={comp.frontPoolByMonth} strong />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">給与計</td>
            <MonthCells rec={comp.frontSalaryByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">ボーナス按分値</td>
            <MonthCells rec={comp.frontBonusByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">社会保険料</td>
            <MonthCells rec={comp.frontInsuranceByMonth} />
          </tr>

          {/* コーポレート */}
          <tr className="labor-divhead">
            <td>コーポレート（按分対象外）</td>
            <MonthCells rec={comp.corporateByMonth} strong />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">給与計</td>
            <MonthCells rec={comp.corporateSalaryByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">ボーナス按分値</td>
            <MonthCells rec={comp.corporateBonusByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">社会保険料</td>
            <MonthCells rec={comp.corporateInsuranceByMonth} />
          </tr>

          <tr className="labor-grand">
            <td>全社人件費 総計（社保込み）</td>
            <MonthCells rec={comp.grandTotalByMonth} strong />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function DivBlock({
  d,
  MonthCells,
}: {
  d: HalfComputation["divs"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <tr className="labor-divhead labor-clickable" onClick={() => setOpen(!open)}>
        <td>
          <span className="labor-caret">{open ? "▾" : "▸"}</span> {d.div}（DIV合計）
        </td>
        <MonthCells rec={d.totalByMonth} strong />
      </tr>
      {open && (
        <>
          {d.tms.map((t) => (
            <TmBlock key={t.tm} t={t} MonthCells={MonthCells} />
          ))}
          <tr className="labor-sub labor-line">
            <td className="labor-indent">プロダクト計（スタッフ人件費）</td>
            <MonthCells rec={d.productByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">フロント按分</td>
            <MonthCells rec={d.frontAllocByMonth} />
          </tr>
        </>
      )}
    </>
  );
}

function TmBlock({
  t,
  MonthCells,
}: {
  t: HalfComputation["divs"][number]["tms"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="labor-tmhead labor-clickable" onClick={() => setOpen(!open)}>
        <td className="labor-indent">
          <span className="labor-caret">{open ? "▾" : "▸"}</span> {t.tm}
          <span className="labor-mcount">（{t.members.length}名）</span>
        </td>
        <MonthCells rec={t.totalByMonth} />
      </tr>
      {open && (
        <>
          {t.members.map((m, i) => (
            <tr key={m.personId + i} className="labor-member">
              <td className="labor-indent2">
                {m.name}
                {m.share < 1 && (
                  <span className="labor-share">×{Math.round(m.share * 100)}%</span>
                )}
              </td>
              {Object.keys(t.salaryByMonth).map((mo) => (
                <td key={mo} className="labor-num">
                  {m.months[mo] ? m.months[mo].toLocaleString(undefined, { maximumFractionDigits: 1 }) : ""}
                </td>
              ))}
              <td className="labor-num">
                {Object.values(m.months).reduce((s, v) => s + v, 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </td>
            </tr>
          ))}
          <tr className="labor-member labor-calc">
            <td className="labor-indent2">ボーナス按分値（Σボーナス÷6）</td>
            {Object.keys(t.bonusByMonth).map((mo) => (
              <td key={mo} className="labor-num">{Math.round(t.bonusByMonth[mo] * 10) / 10}</td>
            ))}
            <td className="labor-num">
              {Math.round(Object.values(t.bonusByMonth).reduce((s, v) => s + v, 0) * 10) / 10}
            </td>
          </tr>
          <tr className="labor-member labor-calc">
            <td className="labor-indent2">社会保険料</td>
            {Object.keys(t.insuranceByMonth).map((mo) => (
              <td key={mo} className="labor-num">{Math.round(t.insuranceByMonth[mo] * 10) / 10}</td>
            ))}
            <td className="labor-num">
              {Math.round(Object.values(t.insuranceByMonth).reduce((s, v) => s + v, 0) * 10) / 10}
            </td>
          </tr>
        </>
      )}
    </>
  );
}
