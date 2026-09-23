import { useMemo, useState, type ReactElement } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import type { Half, HalfComputation, TermCode } from "../../lib/laborCost";
import { computeHalf, fmtMan } from "../../lib/laborCost";

/** personId → 正式名称（個人別シートと同じ規則: マスターの display_name || full_name、無ければ labor_people.name）。 */
export type NameResolver = (personId: string, fallback: string) => string;

const round1 = (v: number) => Math.round(v * 10) / 10;

/** メンバー行の左に出す 夏ボ/冬ボ チップ（0 は非表示）。 */
function BonusChip({ label, value }: { label: string; value: number }) {
  if (!value) return null;
  return (
    <span className="labor-bonuschip" title={`${label}（半期ボーナス）`}>
      {label} {round1(value).toLocaleString()}
    </span>
  );
}

/** 「ボーナス按分値」行のラベル。各人のボーナス合計 Σ を明示し ÷6 の式を見せる。 */
function bonusRowLabel(label: string, members: { bonus: number }[]): string {
  const sum = round1(members.reduce((s, m) => s + m.bonus, 0));
  return `ボーナス按分値（${label}計 Σ${sum.toLocaleString()}万 ÷6）`;
}

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
  const [half, setHalf] = useState<Half | "FY">("H1");

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

  const compOf = (h: Half): HalfComputation | null => {
    if (!termRow) return null;
    return computeHalf({
      term: termRow,
      half: h,
      people: store.people,
      assignments: store.assignments,
      amounts: store.amounts,
      deptMap: store.deptMap,
      tms: store.tms,
      frontTargets: store.frontTargets,
      tmTargets: store.tmTargets,
      insuranceRate: store.insuranceRate,
      smoothSalary: true, // DIV按分は給与を半期内均等ならし（個人の凸凹を隠す）
    });
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compH1 = useMemo(() => compOf("H1"), [termRow, store.people, store.assignments, store.amounts, store.deptMap, store.tms, store.frontTargets, store.tmTargets, store.insuranceRate]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const compH2 = useMemo(() => compOf("H2"), [termRow, store.people, store.assignments, store.amounts, store.deptMap, store.tms, store.frontTargets, store.tmTargets, store.insuranceRate]);

  if (!termRow || !compH1 || !compH2) return null;

  const halfSwitch = (
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
      <button
        className={"labor-btn" + (half === "FY" ? " labor-btn--on" : "")}
        onClick={() => setHalf("FY")}
      >
        通期（上期・下期の比較）
      </button>
    </div>
  );

  if (half === "FY") {
    return (
      <div className="labor-div">
        <div className="labor-toolbar">
          {halfSwitch}
          <span className="labor-note">
            月額＝半期内で一定（在籍・異動・休職は6ヶ月で均した値）／ 増減＝下期計 − 上期計
          </span>
        </div>
        <FullYearTable h1={compH1} h2={compH2} nameOf={nameOf} />
      </div>
    );
  }

  const comp = half === "H1" ? compH1 : compH2;

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
  // 上期=夏ボ / 下期=冬ボ。メンバー行のボーナス表示ラベルに使う。
  const bonusLabel = half === "H1" ? "夏ボ" : "冬ボ";

  const groupLabel = (g: "front" | "overhead") =>
    g === "front" ? "フロントDIV" : "HR/開発/コーポ・その他";

  return (
    <div className="labor-div">
      <div className="labor-toolbar">
        {halfSwitch}
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
            <DivBlock key={d.div} d={d} MonthCells={MonthCells} nameOf={nameOf} bonusLabel={bonusLabel} />
          ))}

          {/* 按分原資プール（フロント → 間接の順・group付き） */}
          {comp.pools.map((p) => (
            <PoolBlock key={p.name} p={p} groupLabel={groupLabel} MonthCells={MonthCells} nameOf={nameOf} bonusLabel={bonusLabel} />
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

export function DivBlock({
  d,
  MonthCells,
  nameOf,
  bonusLabel,
}: {
  d: HalfComputation["divs"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
  nameOf: NameResolver;
  bonusLabel: string;
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
            <TmBlock key={t.tm} t={t} MonthCells={MonthCells} nameOf={nameOf} bonusLabel={bonusLabel} />
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

export function PoolBlock({
  p,
  groupLabel,
  MonthCells,
  nameOf,
  bonusLabel,
}: {
  p: HalfComputation["pools"][number];
  groupLabel: (g: "front" | "overhead") => string;
  MonthCells: (q: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
  nameOf: NameResolver;
  bonusLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const monthKeys = Object.keys(p.salaryByMonth);
  return (
    <>
      <tr className="labor-divhead labor-clickable" onClick={() => setOpen(!open)}>
        <td>
          <span className="labor-caret">{open ? "▾" : "▸"}</span> {p.name}（按分原資・
          {groupLabel(p.group)}）
          <span className="labor-mcount">（{p.members.length}名）</span>
        </td>
        <MonthCells rec={p.totalByMonth} strong />
      </tr>
      {open && (
        <>
          {p.members.map((m, i) => (
            <tr key={m.personId + i} className="labor-member">
              <td className="labor-indent2">
                <BonusChip label={bonusLabel} value={m.bonus} />
                {nameOf(m.personId, m.name)}
                {m.share < 1 && (
                  <span className="labor-share">×{Math.round(m.share * 100)}%</span>
                )}
              </td>
              {monthKeys.map((mo) => (
                <td key={mo} className="labor-num">
                  {m.months[mo] ? m.months[mo].toLocaleString(undefined, { maximumFractionDigits: 1 }) : ""}
                </td>
              ))}
              <td className="labor-num">
                {Object.values(m.months).reduce((s, v) => s + v, 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}
              </td>
            </tr>
          ))}
          <tr className="labor-sub labor-line">
            <td className="labor-indent">給与計</td>
            <MonthCells rec={p.salaryByMonth} />
          </tr>
          <tr className="labor-sub">
            <td className="labor-indent">{bonusRowLabel(bonusLabel, p.members)}</td>
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
  bonusLabel,
}: {
  t: HalfComputation["divs"][number]["tms"][number];
  MonthCells: (p: { rec: Record<string, number>; strong?: boolean }) => ReactElement;
  nameOf: NameResolver;
  bonusLabel: string;
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
                <BonusChip label={bonusLabel} value={m.bonus} />
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
            <td className="labor-indent2">{bonusRowLabel(bonusLabel, t.members)}</td>
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

// ── 通期（上期・下期を1画面で比較） ─────────────────────────────────

type FyLine = {
  key: string;
  label: string;
  kind: "div" | "tm" | "member" | "sub" | "pool" | "grand";
  h1: number;
  h2: number;
  /** 半期内の月額（一定）。上期6ヶ月・下期6ヶ月 */
  h1m: number;
  h2m: number;
  parent?: string;
};

const sumRec = (rec: Record<string, number> | undefined) =>
  rec ? Object.values(rec).reduce((s, v) => s + v, 0) : 0;

function buildFyLines(h1: HalfComputation, h2: HalfComputation, nameOf: NameResolver): FyLine[] {
  const lines: FyLine[] = [];
  const line = (
    key: string, label: string, kind: FyLine["kind"],
    a: Record<string, number> | undefined, b: Record<string, number> | undefined, parent?: string,
  ) => {
    const s1 = sumRec(a), s2 = sumRec(b);
    lines.push({ key, label, kind, h1: s1, h2: s2, h1m: s1 / 6, h2m: s2 / 6, parent });
  };
  const memberRec = (m: { months: Record<string, number> } | undefined) => m?.months;
  const divNames = [...h1.divs.map((d) => d.div), ...h2.divs.map((d) => d.div)]
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const div of divNames) {
    const d1 = h1.divs.find((d) => d.div === div);
    const d2 = h2.divs.find((d) => d.div === div);
    line(`div:${div}`, `${div}（DIV合計）`, "div", d1?.totalByMonth, d2?.totalByMonth);
    const tmNames = [...(d1?.tms ?? []), ...(d2?.tms ?? [])].map((t) => t.tm)
      .filter((v, i, a) => a.indexOf(v) === i);
    for (const tm of tmNames) {
      const t1 = d1?.tms.find((t) => t.tm === tm);
      const t2 = d2?.tms.find((t) => t.tm === tm);
      const tkey = `tm:${div}:${tm}`;
      line(tkey, tm, "tm", t1?.totalByMonth, t2?.totalByMonth, `div:${div}`);
      const ids = [...(t1?.members ?? []), ...(t2?.members ?? [])]
        .map((m) => ({ id: m.personId, name: m.name }))
        .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
      for (const m of ids) {
        line(`${tkey}:${m.id}`, nameOf(m.id, m.name), "member",
          memberRec(t1?.members.find((x) => x.personId === m.id)),
          memberRec(t2?.members.find((x) => x.personId === m.id)), tkey);
      }
    }
    line(`sub:${div}:product`, "プロダクト計（スタッフ人件費）", "sub", d1?.productByMonth, d2?.productByMonth, `div:${div}`);
    line(`sub:${div}:front`, "フロント按分", "sub", d1?.frontAllocByMonth, d2?.frontAllocByMonth, `div:${div}`);
    line(`sub:${div}:overhead`, "HR/開発/コーポ・その他按分", "sub", d1?.overheadAllocByMonth, d2?.overheadAllocByMonth, `div:${div}`);
  }
  const poolNames = [...h1.pools.map((p) => p.name), ...h2.pools.map((p) => p.name)]
    .filter((v, i, a) => a.indexOf(v) === i);
  for (const name of poolNames) {
    const p1 = h1.pools.find((p) => p.name === name);
    const p2 = h2.pools.find((p) => p.name === name);
    const pkey = `pool:${name}`;
    line(pkey, `${name}（按分原資）`, "pool", p1?.totalByMonth, p2?.totalByMonth);
    const ids = [...(p1?.members ?? []), ...(p2?.members ?? [])]
      .map((m) => ({ id: m.personId, name: m.name }))
      .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i);
    for (const m of ids) {
      line(`${pkey}:${m.id}`, nameOf(m.id, m.name), "member",
        memberRec(p1?.members.find((x) => x.personId === m.id)),
        memberRec(p2?.members.find((x) => x.personId === m.id)), pkey);
    }
  }
  if (sumRec(h1.corporateByMonth) !== 0 || sumRec(h2.corporateByMonth) !== 0) {
    line("corp", "コーポレート（按分対象外）", "pool", h1.corporateByMonth, h2.corporateByMonth);
  }
  line("grand", "全社人件費 総計（社保込み）", "grand", h1.grandTotalByMonth, h2.grandTotalByMonth);
  return lines;
}

function FullYearTable({ h1, h2, nameOf }: { h1: HalfComputation; h2: HalfComputation; nameOf: NameResolver }) {
  const lines = useMemo(() => buildFyLines(h1, h2, nameOf), [h1, h2, nameOf]);
  // 既定: DIV・プールは開いてTMまで見せる／TM・プールのメンバーは閉じる
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (key: string, kind: FyLine["kind"]) => open[key] ?? kind === "div";
  const byKey = new Map(lines.map((l) => [l.key, l]));
  const visible = (l: FyLine): boolean => {
    if (!l.parent) return true;
    const p = byKey.get(l.parent);
    return !!p && isOpen(p.key, p.kind) && visible(p);
  };
  const hasChildren = new Set(lines.map((l) => l.parent).filter(Boolean) as string[]);
  const rowClass: Record<FyLine["kind"], string> = {
    div: "labor-divhead", pool: "labor-divhead", grand: "labor-grand",
    tm: "labor-tmhead", member: "labor-member", sub: "labor-sub",
  };
  const indent: Record<FyLine["kind"], string> = {
    div: "", pool: "", grand: "", tm: "labor-indent", sub: "labor-indent", member: "labor-indent2",
  };
  const strong = (k: FyLine["kind"]) => k === "div" || k === "pool" || k === "grand";
  const diffCell = (v: number) => {
    const r = round1(v);
    return (
      <td className={"labor-num" + (r > 0 ? " labor-fy-diff--up" : r < 0 ? " labor-fy-diff--down" : "")}>
        {r > 0 ? "+" : ""}{fmtMan(r)}
      </td>
    );
  };
  return (
    <table className="labor-divtable labor-fytable">
      <thead>
        <tr>
          <th className="labor-head-item" rowSpan={2}>項目</th>
          <th className="labor-fy-group labor-fy-sep" colSpan={2}>上期（7〜12月）</th>
          <th className="labor-fy-group labor-fy-sep" colSpan={2}>下期（1〜6月）</th>
          <th className="labor-fy-group labor-fy-sep" colSpan={2}>通期</th>
        </tr>
        <tr>
          <th className="labor-fy-sep">月額</th><th>上期計</th>
          <th className="labor-fy-sep">月額</th><th>下期計</th>
          <th className="labor-fy-sep">通期計</th><th>増減（下−上）</th>
        </tr>
      </thead>
      <tbody>
        {lines.filter(visible).map((l) => {
          const canToggle = hasChildren.has(l.key);
          const o = isOpen(l.key, l.kind);
          const S = strong(l.kind) ? " labor-strong" : "";
          return (
            <tr
              key={l.key}
              className={rowClass[l.kind] + (canToggle ? " labor-clickable" : "")}
              onClick={canToggle ? () => setOpen((cur) => ({ ...cur, [l.key]: !o })) : undefined}
            >
              <td className={indent[l.kind]}>
                {canToggle && <span className="labor-caret">{o ? "▾" : "▸"}</span>} {l.label}
              </td>
              <td className={"labor-num labor-fy-sep" + S}>{fmtMan(l.h1m)}</td>
              <td className={"labor-num" + S}>{fmtMan(l.h1)}</td>
              <td className={"labor-num labor-fy-sep" + S}>{fmtMan(l.h2m)}</td>
              <td className={"labor-num" + S}>{fmtMan(l.h2)}</td>
              <td className={"labor-num labor-fy-sep labor-strong"}>{fmtMan(l.h1 + l.h2)}</td>
              {diffCell(l.h2 - l.h1)}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
