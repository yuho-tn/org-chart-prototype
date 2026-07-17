import { useMemo, useState } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import type { Half, TermCode } from "../../lib/laborCost";
import { assignKey } from "../../lib/laborCost";

/**
 * 設定タブ:
 *  1. TM割当（DIV按分出力で使うTMを人ごとに割当・5期）
 *  2. フロント按分の分母（DIV別売上目標・半期固定）
 *  3. 社会保険料率
 *  4. 従業員マスター連携（employee_number 突合・退職フラグ同期）
 */

export function LaborSettingsTab({ term }: { term: TermCode }) {
  const store = useLaborCostStore();
  const employees = useEmployeesStore((s) => s.employees);

  // ── 1. TM割当対象 = product 扱いの所属を持つ人（当期・在籍優先ソート）──
  const productDepts = useMemo(
    () =>
      new Set(
        store.deptMap
          .filter((m) => m.term === term && m.treatment === "product")
          .map((m) => m.dept),
      ),
    [store.deptMap, term],
  );

  const tmTargets = useMemo(() => {
    const rows: {
      personId: string;
      name: string;
      departed: boolean;
      dept: string;
      tm: string | null;
    }[] = [];
    for (const p of [...store.people].sort((a, b) => a.sort_order - b.sort_order)) {
      const a1 = store.assignments[assignKey(p.id, term, "H1")];
      const a2 = store.assignments[assignKey(p.id, term, "H2")];
      const dept =
        (a1?.dept && productDepts.has(a1.dept) && a1.dept) ||
        (a2?.dept && productDepts.has(a2.dept) && a2.dept) ||
        (a1?.kenmu_dept && productDepts.has(a1.kenmu_dept) && a1.kenmu_dept) ||
        (a2?.kenmu_dept && productDepts.has(a2.kenmu_dept) && a2.kenmu_dept) ||
        null;
      if (!dept) continue;
      rows.push({
        personId: p.id,
        name: p.name,
        departed: p.departed,
        dept,
        tm: a1?.tm ?? a2?.tm ?? null,
      });
    }
    return rows;
  }, [store.people, store.assignments, term, productDepts]);

  const setTm = (personId: string, tm: string | null) => {
    const edits = (["H1", "H2"] as Half[])
      .filter((h) => store.assignments[assignKey(personId, term, h)])
      .map((half) => ({ personId, term, half, tm }));
    if (edits.length > 0) store.applyAssignEdits(edits, "TM割当");
  };

  const unassigned = tmTargets.filter((t) => !t.tm && !t.departed).length;

  // ── 4. マスター連携 ──
  const [linkFilter, setLinkFilter] = useState<"unlinked" | "all">("unlinked");
  const employeeOptions = useMemo(
    () =>
      [...employees]
        .sort((a, b) => (a.employee_number > b.employee_number ? 1 : -1))
        .map((e) => ({
          num: e.employee_number,
          label: `${e.display_name ?? e.full_name ?? "（無名）"}（${e.employee_number}${e.left_at ? "・退職" : ""}）`,
          lastName: (e.full_name ?? "").split(/[\s　]/)[0],
          leftAt: e.left_at,
        })),
    [employees],
  );

  const linkRows = useMemo(() => {
    const rows = [...store.people].sort((a, b) => a.sort_order - b.sort_order);
    return linkFilter === "all" ? rows : rows.filter((p) => !p.employee_number);
  }, [store.people, linkFilter]);

  const autoMatch = () => {
    // 姓が一意に一致する未連携メンバーを自動リンク
    let n = 0;
    for (const p of store.people) {
      if (p.employee_number) continue;
      const base = p.name.replace(/（.*?）/g, "").trim().split(/[\s ]/)[0];
      const hits = employeeOptions.filter((e) => e.lastName === base);
      if (hits.length === 1) {
        void store.updatePerson(p.id, { employee_number: hits[0].num });
        n++;
      }
    }
    alert(n > 0 ? `${n}名を姓の一意一致で連携しました` : "一意に一致する未連携メンバーはありませんでした");
  };

  const syncDeparted = () => {
    // employees.left_at → labor_people.departed を同期
    const byNum = new Map(employeeOptions.map((e) => [e.num, e]));
    let n = 0;
    for (const p of store.people) {
      if (!p.employee_number) continue;
      const e = byNum.get(p.employee_number);
      if (!e) continue;
      const shouldDeparted = !!e.leftAt;
      if (p.departed !== shouldDeparted) {
        void store.updatePerson(p.id, { departed: shouldDeparted });
        n++;
      }
    }
    alert(`退職フラグを${n}名分更新しました（従業員マスターのleft_at基準）`);
  };

  return (
    <div className="labor-settings">
      <section>
        <h3>TM割当（{term}期・DIV按分出力用）</h3>
        <p className="labor-note">
          個人別シートの所属はDIV粒度のため、按分出力のTM粒度はここで割り当てます。
          {unassigned > 0 && (
            <strong className="labor-warn-inline">　未割当 {unassigned}名（（TM未割当）として出力されます）</strong>
          )}
        </p>
        <div className="labor-tmassign">
          {tmTargets.map((t) => (
            <div key={t.personId} className={"labor-tmrow" + (t.departed ? " lg-departed" : "")}>
              <span className="labor-tmname">{t.name}</span>
              <span className="labor-tmdept">{t.dept}</span>
              <select
                className="labor-select"
                value={t.tm ?? ""}
                onChange={(e) => setTm(t.personId, e.target.value || null)}
              >
                <option value="">（TM未割当）</option>
                {store.tms.map((tm) => (
                  <option key={tm.tm} value={tm.tm}>
                    {tm.tm}（{tm.div}）
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3>フロント按分の分母（DIV別売上目標・万円・半期固定）</h3>
        <table className="labor-fronttable">
          <thead>
            <tr>
              <th>DIV</th>
              <th>上期目標</th>
              <th>上期比率</th>
              <th>下期目標</th>
              <th>下期比率</th>
            </tr>
          </thead>
          <tbody>
            {(() => {
              const divs = [...new Set(store.frontTargets.filter((f) => f.term === term).map((f) => f.div))];
              const get = (half: Half, div: string) =>
                store.frontTargets.find((f) => f.term === term && f.half === half && f.div === div)?.sales_target ?? 0;
              const sums: Record<Half, number> = {
                H1: divs.reduce((s, d) => s + get("H1", d), 0),
                H2: divs.reduce((s, d) => s + get("H2", d), 0),
              };
              return divs.map((div) => (
                <tr key={div}>
                  <td>{div}</td>
                  {(["H1", "H2"] as Half[]).map((half) => (
                    <FragmentCells
                      key={half}
                      value={get(half, div)}
                      ratio={sums[half] > 0 ? get(half, div) / sums[half] : 0}
                      onChange={(v) => void store.updateFrontTarget(term, half, div, v)}
                    />
                  ))}
                </tr>
              ));
            })()}
          </tbody>
        </table>
      </section>

      <section>
        <h3>社会保険料率</h3>
        <label className="labor-inline">
          <input
            type="number"
            step="0.1"
            className="labor-rateinput"
            value={Math.round(store.insuranceRate * 1000) / 10}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) void store.updateInsuranceRate(v / 100);
            }}
          />
          %（給与＋ボーナス按分に乗算して加算）
        </label>
      </section>

      <section>
        <h3>従業員マスター連携（TalentHub employees）</h3>
        <div className="labor-toolbar">
          <button className="labor-btn" onClick={autoMatch}>姓の一意一致で自動連携</button>
          <button className="labor-btn" onClick={syncDeparted}>退職フラグをマスターと同期</button>
          <label className="labor-check">
            <input
              type="checkbox"
              checked={linkFilter === "all"}
              onChange={(e) => setLinkFilter(e.target.checked ? "all" : "unlinked")}
            />
            連携済みも表示
          </label>
        </div>
        <div className="labor-tmassign">
          {linkRows.map((p) => (
            <div key={p.id} className={"labor-tmrow" + (p.departed ? " lg-departed" : "")}>
              <span className="labor-tmname">{p.name}</span>
              <select
                className="labor-select"
                value={p.employee_number ?? ""}
                onChange={(e) =>
                  void store.updatePerson(p.id, { employee_number: e.target.value || null })
                }
              >
                <option value="">（未連携）</option>
                {employeeOptions.map((e) => (
                  <option key={e.num} value={e.num}>{e.label}</option>
                ))}
              </select>
              <label className="labor-incentive" title="インセンティブの売上に対する掛け率（フロント陣のみ）">
                インセン
                <input
                  className="labor-rateinput labor-rateinput--sm"
                  type="number"
                  step="1"
                  min="0"
                  placeholder="—"
                  value={p.incentive_rate != null ? Math.round(p.incentive_rate * 1000) / 10 : ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    void store.updatePerson(p.id, {
                      incentive_rate: v === "" ? null : Number(v) / 100,
                    });
                  }}
                />
                %
              </label>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function FragmentCells({
  value,
  ratio,
  onChange,
}: {
  value: number;
  ratio: number;
  onChange: (v: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <td className="labor-num">
        <input
          className="labor-targetinput"
          value={draft ?? value.toLocaleString()}
          onFocus={() => setDraft(String(value))}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft != null) {
              const v = Number(draft.replace(/,/g, ""));
              if (Number.isFinite(v) && v >= 0 && v !== value) onChange(v);
            }
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </td>
      <td className="labor-num">{(Math.round(ratio * 1000) / 10).toFixed(1)}%</td>
    </>
  );
}
