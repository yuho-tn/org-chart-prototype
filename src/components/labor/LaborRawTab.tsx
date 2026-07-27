import { useMemo, useState } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import type { TermCode } from "../../lib/laborCost";
import {
  buildRawRows,
  computeHalf,
  rawRowsToCsv,
  rawRowsToTsv,
} from "../../lib/laborCost";

/**
 * ローデータ出力: 年月 / TM / Div / 種別（プロダクト・フロント・総額）/ 金額（万円）。
 * スプレッドシート貼り付け用TSVコピーと CSV ダウンロードに対応。
 */

export function LaborRawTab({ term }: { term: TermCode }) {
  const store = useLaborCostStore();
  const [copied, setCopied] = useState(false);
  const [kindFilter, setKindFilter] = useState<string>("all");

  const termRow = store.terms.find((t) => t.code === term);

  const rows = useMemo(() => {
    if (!termRow) return [];
    const comps = (["H1", "H2"] as const).map((half) =>
      computeHalf({
        term: termRow,
        half,
        people: store.people,
        assignments: store.assignments,
        amounts: store.amounts,
        deptMap: store.deptMap,
        tms: store.tms,
        frontTargets: store.frontTargets,
        insuranceRate: store.insuranceRate,
      }),
    );
    return buildRawRows(termRow, comps);
  }, [termRow, store.people, store.assignments, store.amounts, store.deptMap, store.tms, store.frontTargets, store.insuranceRate]);

  const filtered = useMemo(
    () => (kindFilter === "all" ? rows : rows.filter((r) => r.kind === kindFilter)),
    [rows, kindFilter],
  );

  if (!termRow) return null;

  const copy = async () => {
    await navigator.clipboard.writeText(rawRowsToTsv(filtered));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const download = () => {
    const bom = "﻿"; // Excel向けBOM
    const blob = new Blob([bom + rawRowsToCsv(filtered)], {
      type: "text/csv;charset=utf-8",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `人件費ローデータ_${termRow.label.replace(/[（）\/〜]/g, "")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="labor-raw">
      <div className="labor-toolbar">
        <select
          className="labor-select"
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
        >
          <option value="all">すべての種別</option>
          <option value="プロダクト">プロダクトのみ</option>
          <option value="フロント">フロント按分のみ</option>
          <option value="間接費">間接費按分のみ</option>
          <option value="総額">総額のみ</option>
          <option value="コーポレート">コーポレートのみ</option>
        </select>
        <button className="labor-btn" onClick={() => void copy()}>
          {copied ? "✓ コピーしました" : "スプレッドシート貼り付け用にコピー"}
        </button>
        <button className="labor-btn" onClick={download}>
          CSVダウンロード
        </button>
        <span className="labor-note">{filtered.length}行 ／ 金額は万円・社保込み</span>
      </div>
      <table className="labor-rawtable">
        <thead>
          <tr>
            <th>年月</th>
            <th>TM</th>
            <th>Div</th>
            <th>種別</th>
            <th className="labor-num">金額（万円）</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((r, i) => (
            <tr key={i} className={`labor-raw-${r.kind}`}>
              <td>{r.ym}</td>
              <td>{r.tm}</td>
              <td>{r.div}</td>
              <td>{r.kind}</td>
              <td className="labor-num">{r.amount.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
