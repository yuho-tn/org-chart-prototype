import { useMemo, useState, type ReactElement } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import type { Half, HalfComputation, TermCode } from "../../lib/laborCost";
import { computeHalf, fmtMan } from "../../lib/laborCost";

/** personId → 正式名称（個人別シートと同じ規則: マスターの display_name || full_name、無ければ labor_people.name）。 */
type NameResolver = (personId: string, fallback: string) => string;

/**
 * DIV別 月次按分ビュー（読み取り専用・自動計算）。
 * - メンバー月次給与（兼務率で分割計上）
 * - ボーナス按分値（半期ボーナス ÷ 6）
 * - 社会保険料（(給与+ボーナス按分) × 率）
 * - 按分原資プールを売上目標比で各DIVへ配賦。表示は2グループ:
 *     フロント按分（フロントDIV原資）
 *     HR/開発/コーポ・その他按分（HR TM/開発TM/コーポレートTM/他の原資）
 */

export function LaborDivTab({ term }: { term: TermCode }) {
  const store = useLaborCostStore();
  const employees = useEmployeesStore((s) => s.employees);
  const [half, setHalf] = useState<Half>("H1");

  const termRow = store.terms.find((t) => t.code === term);

  // DIV按分のメンバー名を個人別シートと同じ「正式名称」で表示する
  // （集計は labor_people.name の省略名を使うため、ここで従業員マスター名に解決）。
  const nameOf: NameResolver = useMemo(() => {
    const empByNum = new Map(employees.map((e) => [e.employee_number, e]));
    const numByPerson = new Map(store.people.map((p) => [p.id, p.employee_number]));
    return (personId: string, fallback: string) => {
      const num = numByPerson.get(personId);
      const emp = num ? empByNum.get(num) : null;
      return emp?.display_name || emp?.full_name || fallback;
    };
  }, [employees, store.people]);

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

  const corpTotal = sum(comp.corporateByMonth);

  const groupLabel = (g: "front" | "overhead") =>
    g === "front" ? "フロントDIV" : "HR/開発/コーポ・その他";

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
          按分（フロント・間接費）は売上目標比（
          {Object.entries(comp.frontRatios)
            .map(([d, r]) => `${d} ${Math.round(r * 1000) / 10}%`)
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

      {comp.unallocated && (
        <div className="labor-warn">
          ⚠ 按分原資を各DIVへ配分し切れていません（売上目標が未登録/0の可能性）。
          残差 {fmtMan(sum(comp.unallocatedByMonth))}万円/半期は
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
            <DivBlock key={d.div} d={d} MonthCells={MonthCells} nameOf={nameOf} />
          ))}

          {/* 按分原資プール（フロント → 間接の順・group付き） */}
          {comp.pools.map((p) => (
            <PoolBlock key={p.name} p={p} groupLabel={groupLabel} MonthCells={MonthCells} />
          ))}

          {/* コーポレート treatment（5期は無し・後方互換で非0時のみ表示） */}
          {corpTotal !== 0 && (
            <>
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
            </>
          )}

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
  nameOf,
}: {
  d: HalfComputation["divs"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
  nameOf: NameResolver;
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
            <TmBlock key={t.tm} t={t} MonthCells={MonthCells} nameOf={nameOf} />
          ))}
          <tr className="labor-sub labor-line">
            <td className="labor-indent">プロダクト計（スタッフ人件費）</td>
            <MonthCells rec={d.productByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">フロント按分</td>
            <MonthCells rec={d.frontAllocByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">HR/開発/コーポ・その他按分</td>
            <MonthCells rec={d.overheadAllocByMonth} />
          </tr>
        </>
      )}
    </>
  );
}

function PoolBlock({
  p,
  groupLabel,
  MonthCells,
}: {
  p: HalfComputation["pools"][number];
  groupLabel: (g: "front" | "overhead") => string;
  MonthCells: (q: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="labor-divhead labor-clickable" onClick={() => setOpen(!open)}>
        <td>
          <span className="labor-caret">{open ? "▾" : "▸"}</span> {p.name}（按分原資・
          {groupLabel(p.group)}）
        </td>
        <MonthCells rec={p.totalByMonth} strong />
      </tr>
      {open && (
        <>
          <tr className="labor-sub">
            <td className="labor-indent">給与計</td>
            <MonthCells rec={p.salaryByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">ボーナス按分値</td>
            <MonthCells rec={p.bonusByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">社会保険料</td>
            <MonthCells rec={p.insuranceByMonth} />
          </tr>
        </>
      )}
    </>
  );
}

function TmBlock({
  t,
  MonthCells,
  nameOf,
}: {
  t: HalfComputation["divs"][number]["tms"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
  nameOf: NameResolver;
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
                {nameOf(m.personId, m.name)}
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
