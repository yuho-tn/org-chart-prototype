import { useEffect, useMemo, useRef, useState } from "react";
import { usePayrollStore, getRecord, isRecentlyEdited } from "../../store/usePayrollStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import { PresenceAvatars } from "../PresenceAvatars";
import type {
  CareerTrack,
  EmployeeRow,
  EvaluationGrade,
  GradeRow,
  PeriodCode,
  PeriodRow,
  SalaryRecordRow,
} from "../../lib/supabase";

// ── Formatting helpers ──────────────────────────────────────────────

function fmtYen(yen: number | null | undefined): string {
  if (yen == null || yen === 0) return "—";
  return yen.toLocaleString();
}

function fmtMan(yen: number | null | undefined): string {
  if (yen == null || yen === 0) return "—";
  return `${(yen / 10000).toFixed(yen % 10000 === 0 ? 0 : 1)}万`;
}

function fmtDelta(curr: number, prev: number): { text: string; pct: string; sign: "+" | "-" | "0" } {
  if (prev === 0 || prev == null) return { text: "—", pct: "—", sign: "0" };
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  if (diff === 0) return { text: "±0", pct: "0%", sign: "0" };
  return {
    text: (diff > 0 ? "+" : "") + (diff / 10000).toFixed(diff % 10000 === 0 ? 0 : 1) + "万",
    pct: (pct > 0 ? "+" : "") + pct.toFixed(1) + "%",
    sign: diff > 0 ? "+" : "-",
  };
}

const EVAL_GRADES: EvaluationGrade[] = ["S", "A+", "A", "B+", "B", "B-", "C", "D"];
const CAREER_TRACK_LABEL: Record<CareerTrack, string> = {
  management: "マネジメント",
  specialist: "スペシャリスト",
  diverse: "多様な正社員",
};

// ── URL hash expansion state ────────────────────────────────────────
// The salary table preserves which half-period columns are expanded
// across reload via #expand=4H2,5H1 fragment.

function readExpandedFromUrl(): Set<PeriodCode> {
  const m = /[?&#]expand=([^&]+)/.exec(window.location.hash + window.location.search);
  if (!m) return new Set();
  return new Set(m[1].split(",").filter(Boolean) as PeriodCode[]);
}

function writeExpandedToUrl(set: Set<PeriodCode>) {
  // Stored in a sub-fragment after the existing hash route. We keep the
  // route as the primary fragment and append ?expand=... at the end.
  const route = useUiStore.getState().route;
  const baseHash = `#/payroll${route.name === "salary" ? "" : ""}`;
  const params = set.size > 0 ? `?expand=${Array.from(set).join(",")}` : "";
  const next = baseHash + params;
  if (window.location.hash !== next.slice(1)) {
    // replaceState so this doesn't pollute the back-button history
    window.history.replaceState({}, "", window.location.pathname + window.location.search + next);
  }
}

// ── Filtering ───────────────────────────────────────────────────────

type FilterState = {
  search: string;
  department: string;
  employmentType: string;
  track: CareerTrack | "" | "unset";
  showRetired: boolean;
};

const EMPTY_FILTER: FilterState = {
  search: "",
  department: "",
  employmentType: "",
  track: "",
  showRetired: false,
};

function uniqueSorted(values: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of values) if (v && v.trim()) set.add(v);
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

// ── CSV export ──────────────────────────────────────────────────────

function exportCsv(
  employees: EmployeeRow[],
  periods: PeriodRow[],
  records: Record<string, SalaryRecordRow>,
  grades: GradeRow[],
) {
  const gradeMap = new Map(grades.map((g) => [g.code, g.label]));
  const headers = [
    "社員番号", "氏名", "雇用形態", "部署", "役職", "トラック",
    ...periods.flatMap((p) => [
      `${p.label} 等級`, `${p.label} 月給(円)`, `${p.label} 査定`, `${p.label} コメント`,
    ]),
  ];
  const rows = employees.map((e) => {
    const base = [
      e.employee_number, e.full_name ?? "", e.employment_type ?? "",
      e.department ?? "", e.position_title ?? "", e.career_track ?? "",
    ];
    for (const p of periods) {
      const r = getRecord(records, e.employee_number, p.code);
      base.push(r?.grade_code ? `${r.grade_code}(${gradeMap.get(r.grade_code) ?? ""})` : "");
      base.push(r?.total_monthly_salary != null ? String(r.total_monthly_salary) : "");
      base.push(r?.evaluation_grade ?? "");
      base.push(r?.comment ?? "");
    }
    return base;
  });
  const csv = [headers, ...rows].map((row) =>
    row.map((cell) => {
      const s = String(cell ?? "");
      if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }).join(","),
  ).join("\n");
  // Prepend BOM so Excel opens it as UTF-8
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `salary_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Main component ──────────────────────────────────────────────────

/**
 * 給与表ページ。在籍中の全従業員 × 9半期のマトリクス。各半期は折りたたみ
 * デフォルト、+で4列(等級/月給/査定/コメント)に展開。インライン編集 →
 * debounce 自動保存 → リアルタイム同期。サマリーバーで現在ハイライト
 * 半期の合計・前期比・予算超過を表示。
 */
export function SalaryTablePage() {
  // Data
  const employees = useEmployeesStore((s) => s.employees);
  const employeesLoading = useEmployeesStore((s) => s.loading);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const grades = usePayrollStore((s) => s.grades);
  const periods = usePayrollStore((s) => s.periods);
  const records = usePayrollStore((s) => s.records);
  const recentEdits = usePayrollStore((s) => s.recentEdits);
  const loaded = usePayrollStore((s) => s.loaded);
  const loading = usePayrollStore((s) => s.loading);
  const error = usePayrollStore((s) => s.error);
  const refreshPayroll = usePayrollStore((s) => s.refresh);
  const subscribe = usePayrollStore((s) => s.subscribe);
  const unsubscribe = usePayrollStore((s) => s.unsubscribe);
  const upsertSalaryRecord = usePayrollStore((s) => s.upsertSalaryRecord);
  const setPeriodBudget = usePayrollStore((s) => s.setPeriodBudget);
  const setEmployeeCareerTrack = usePayrollStore((s) => s.setEmployeeCareerTrack);

  const role = useAuthStore((s) => s.currentUser?.role);
  const canEdit = role === "master" || role === "privileged_admin";
  const setToast = useOrgStore((s) => s.setToast);

  // ── State ─────────────────────────────────────────────────────────
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [expanded, setExpanded] = useState<Set<PeriodCode>>(() =>
    typeof window === "undefined" ? new Set() : readExpandedFromUrl(),
  );
  // Which period the summary bar focuses on (defaults to the latest
  // period whose start_date is <= today)
  const [summaryPeriod, setSummaryPeriod] = useState<PeriodCode | null>(null);

  // Initial loads
  useEffect(() => { refreshEmployees(); }, [refreshEmployees]);
  useEffect(() => { if (!loaded) refreshPayroll(); }, [loaded, refreshPayroll]);

  // Realtime sub
  useEffect(() => {
    subscribe();
    return () => { unsubscribe(); };
  }, [subscribe, unsubscribe]);

  // Persist expanded state to URL
  useEffect(() => {
    writeExpandedToUrl(expanded);
  }, [expanded]);

  // Default summaryPeriod = the period containing today, else the latest
  useEffect(() => {
    if (summaryPeriod || periods.length === 0) return;
    const today = new Date().toISOString().slice(0, 10);
    const current = periods.find((p) => p.start_date <= today && today <= p.end_date);
    setSummaryPeriod((current ?? periods[periods.length - 1]).code);
  }, [periods, summaryPeriod]);

  // ── Filtering ─────────────────────────────────────────────────────
  const distinctDepts = useMemo(() => uniqueSorted(employees.map((e) => e.department)), [employees]);
  const distinctEmps = useMemo(() => uniqueSorted(employees.map((e) => e.employment_type)), [employees]);

  const filteredEmployees = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const q = filter.search.trim().toLowerCase();
    return employees.filter((e) => {
      const isRetired = !!e.left_at && e.left_at <= today;
      if (!filter.showRetired && isRetired) return false;
      if (filter.department && e.department !== filter.department) return false;
      if (filter.employmentType && e.employment_type !== filter.employmentType) return false;
      if (filter.track === "unset" && e.career_track) return false;
      if (filter.track && filter.track !== "unset" && e.career_track !== filter.track) return false;
      if (!q) return true;
      const blob = [
        e.employee_number, e.full_name, e.email, e.department, e.position_title, e.employment_type,
      ].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(q);
    }).sort((a, b) => a.employee_number.localeCompare(b.employee_number));
  }, [employees, filter]);

  // ── Summary ───────────────────────────────────────────────────────
  const summary = useMemo(() => {
    if (!summaryPeriod) return null;
    const period = periods.find((p) => p.code === summaryPeriod);
    if (!period) return null;
    const sumFor = (code: PeriodCode) => {
      let total = 0;
      let filledCount = 0;
      for (const e of filteredEmployees) {
        const r = getRecord(records, e.employee_number, code);
        if (r?.total_monthly_salary) {
          total += r.total_monthly_salary;
          filledCount += 1;
        }
      }
      return { total, filledCount };
    };
    const curr = sumFor(summaryPeriod);
    const sortedPeriods = [...periods].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sortedPeriods.findIndex((p) => p.code === summaryPeriod);
    const prevCode = idx > 0 ? sortedPeriods[idx - 1].code : null;
    const prev = prevCode ? sumFor(prevCode) : null;
    return { period, curr, prev, delta: prev ? fmtDelta(curr.total, prev.total) : null };
  }, [summaryPeriod, periods, filteredEmployees, records]);

  // ── Period column toggles ─────────────────────────────────────────
  function toggleExpand(code: PeriodCode) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code); else next.add(code);
      return next;
    });
  }
  function expandAll() { setExpanded(new Set(periods.map((p) => p.code))); }
  function collapseAll() { setExpanded(new Set()); }

  const sortedPeriods = useMemo(
    () => [...periods].sort((a, b) => a.sort_order - b.sort_order),
    [periods],
  );

  // ── Render ───────────────────────────────────────────────────────
  return (
    <main className="page payroll-page payroll-page--full">
      <div className="page__header">
        <div>
          <h1 className="page__title">給与表</h1>
          <p className="page__subtitle">
            在籍中の全従業員 × 9半期の決定マトリクス。各半期は折りたたみ状態がデフォルト、＋で展開。
            {canEdit ? "セルをクリックするとインライン編集できます（自動保存）。" : "閲覧のみです。"}
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--ghost btn--xs" onClick={expandAll}>全展開</button>{" "}
          <button className="btn btn--ghost btn--xs" onClick={collapseAll}>全折畳</button>{" "}
          <button
            className="btn btn--ghost"
            onClick={() => exportCsv(filteredEmployees, sortedPeriods, records, grades)}
            title="CSV エクスポート"
          >
            ⬇ CSV
          </button>
          <PresenceAvatars />
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      {/* Summary bar */}
      {summary && (
        <SummaryBar
          summary={summary}
          allPeriods={sortedPeriods}
          summaryPeriod={summaryPeriod!}
          onChangePeriod={setSummaryPeriod}
          onBudgetChange={canEdit ? (yen) => setPeriodBudget(summary.period.code, yen) : undefined}
          filteredCount={filteredEmployees.length}
        />
      )}

      {/* Filters */}
      <div className="emppage__filters">
        <input
          className="field__input"
          placeholder="氏名 / 部署 / 役職 で絞り込み"
          value={filter.search}
          onChange={(e) => setFilter({ ...filter, search: e.target.value })}
          style={{ flex: "2 1 240px" }}
        />
        <select className="field__input" value={filter.department}
          onChange={(e) => setFilter({ ...filter, department: e.target.value })}>
          <option value="">部署：全て</option>
          {distinctDepts.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="field__input" value={filter.employmentType}
          onChange={(e) => setFilter({ ...filter, employmentType: e.target.value })}>
          <option value="">雇用形態：全て</option>
          {distinctEmps.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="field__input" value={filter.track}
          onChange={(e) => setFilter({ ...filter, track: e.target.value as FilterState["track"] })}>
          <option value="">トラック：全て</option>
          <option value="management">マネジメント</option>
          <option value="specialist">スペシャリスト</option>
          <option value="diverse">多様な正社員</option>
          <option value="unset">未割当</option>
        </select>
        <label className="payroll-checkbox">
          <input type="checkbox" checked={filter.showRetired}
            onChange={(e) => setFilter({ ...filter, showRetired: e.target.checked })}
          />
          退職者も表示
        </label>
        {(filter.search || filter.department || filter.employmentType || filter.track || filter.showRetired) && (
          <button className="btn btn--ghost btn--xs" onClick={() => setFilter(EMPTY_FILTER)}>✕ クリア</button>
        )}
        <span className="emppage__count">
          <strong>{filteredEmployees.length}</strong> 名
          {filteredEmployees.length !== employees.length && (
            <span className="emppage__countSub"> / 全 {employees.length}</span>
          )}
        </span>
      </div>

      {/* Salary table */}
      <div className="salary-tableWrap">
        {(loading || employeesLoading) && (
          <p className="usermgr__empty">読み込み中…</p>
        )}
        {!loading && !employeesLoading && filteredEmployees.length === 0 && (
          <p className="usermgr__empty">該当する従業員がいません</p>
        )}
        {!loading && filteredEmployees.length > 0 && (
          <table className="salary-table">
            <thead>
              <tr className="salary-table__group-row">
                <th className="salary-table__fixed" colSpan={5}>従業員</th>
                {sortedPeriods.map((p) => (
                  <PeriodHeader
                    key={p.code}
                    period={p}
                    expanded={expanded.has(p.code)}
                    onToggle={() => toggleExpand(p.code)}
                  />
                ))}
              </tr>
              <tr className="salary-table__head-row">
                <th className="salary-table__fixed">社員番号</th>
                <th className="salary-table__fixed">氏名</th>
                <th className="salary-table__fixed">雇用形態</th>
                <th className="salary-table__fixed">部署</th>
                <th className="salary-table__fixed">役職</th>
                {sortedPeriods.map((p) => (
                  expanded.has(p.code)
                    ? (
                      <>
                        <th key={p.code + "-g"} className="salary-table__subhead">等級</th>
                        <th key={p.code + "-s"} className="salary-table__subhead">月給</th>
                        <th key={p.code + "-e"} className="salary-table__subhead">査定</th>
                        <th key={p.code + "-c"} className="salary-table__subhead">コメント</th>
                      </>
                    )
                    : <th key={p.code + "-sum"} className="salary-table__subhead">等級/月給</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredEmployees.map((emp) => (
                <SalaryRow
                  key={emp.employee_number}
                  employee={emp}
                  periods={sortedPeriods}
                  expanded={expanded}
                  records={records}
                  grades={grades}
                  recentEdits={recentEdits}
                  canEdit={canEdit}
                  onSave={upsertSalaryRecord}
                  onCareerTrackChange={setEmployeeCareerTrack}
                  setToast={setToast}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

// ── Period header ───────────────────────────────────────────────────

function PeriodHeader({
  period, expanded, onToggle,
}: { period: PeriodRow; expanded: boolean; onToggle: () => void }) {
  return (
    <th
      className={`salary-table__period ${expanded ? "is-expanded" : ""}`}
      colSpan={expanded ? 4 : 1}
    >
      <button className="salary-table__periodToggle" onClick={onToggle}>
        <span>{period.label}</span>
        <span className="salary-table__periodDates">
          {period.start_date.slice(0, 7)} 〜 {period.end_date.slice(0, 7)}
        </span>
        <span className="salary-table__caret">{expanded ? "▼" : "▶"}</span>
      </button>
    </th>
  );
}

// ── Summary bar ─────────────────────────────────────────────────────

function SummaryBar({
  summary, allPeriods, summaryPeriod, onChangePeriod, onBudgetChange, filteredCount,
}: {
  summary: NonNullable<ReturnType<typeof useMemo<{ period: PeriodRow; curr: { total: number; filledCount: number }; prev: { total: number; filledCount: number } | null; delta: ReturnType<typeof fmtDelta> | null }>>>;
  allPeriods: PeriodRow[];
  summaryPeriod: PeriodCode;
  onChangePeriod: (p: PeriodCode) => void;
  onBudgetChange?: (yen: number | null) => Promise<unknown>;
  filteredCount: number;
}) {
  const [budgetDraft, setBudgetDraft] = useState<string>(
    summary.period.monthly_salary_budget != null
      ? String(summary.period.monthly_salary_budget) : "",
  );
  useEffect(() => {
    setBudgetDraft(summary.period.monthly_salary_budget != null
      ? String(summary.period.monthly_salary_budget) : "");
  }, [summary.period.code, summary.period.monthly_salary_budget]);

  const overBudget = !!(summary.period.monthly_salary_budget &&
    summary.curr.total > summary.period.monthly_salary_budget);

  const deltaClass = summary.delta?.sign === "+" ? "is-up"
    : summary.delta?.sign === "-" ? "is-down" : "";

  function commitBudget() {
    if (!onBudgetChange) return;
    const trimmed = budgetDraft.trim();
    onBudgetChange(trimmed ? Number(trimmed) : null);
  }

  return (
    <div className={`payroll-summary ${overBudget ? "is-over-budget" : ""}`}>
      <div className="payroll-summary__periodSel">
        <label>表示中</label>
        <select value={summaryPeriod} onChange={(e) => onChangePeriod(e.target.value as PeriodCode)}>
          {allPeriods.map((p) => <option key={p.code} value={p.code}>{p.label}</option>)}
        </select>
      </div>

      <div className="payroll-summary__metric">
        <div className="payroll-summary__metricLabel">月額合計</div>
        <div className="payroll-summary__metricValue">{fmtYen(summary.curr.total)}円</div>
        <div className="payroll-summary__metricSub">
          {summary.curr.filledCount} / {filteredCount} 名分入力済
        </div>
      </div>

      {summary.delta && summary.prev && (
        <div className={`payroll-summary__metric payroll-summary__delta ${deltaClass}`}>
          <div className="payroll-summary__metricLabel">前期比</div>
          <div className="payroll-summary__metricValue">
            {summary.delta.text} <span className="payroll-summary__deltaPct">({summary.delta.pct})</span>
          </div>
          <div className="payroll-summary__metricSub">
            前期 {fmtYen(summary.prev.total)}円
          </div>
        </div>
      )}

      <div className="payroll-summary__metric payroll-summary__budget">
        <div className="payroll-summary__metricLabel">予算（月額）</div>
        {onBudgetChange ? (
          <input
            className="payroll-summary__budgetInput"
            type="number"
            placeholder="未設定"
            value={budgetDraft}
            onChange={(e) => setBudgetDraft(e.target.value)}
            onBlur={commitBudget}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
        ) : (
          <div className="payroll-summary__metricValue">
            {summary.period.monthly_salary_budget ? fmtYen(summary.period.monthly_salary_budget) : "未設定"}
          </div>
        )}
        {summary.period.monthly_salary_budget && (
          <div className="payroll-summary__metricSub">
            残 {fmtYen(summary.period.monthly_salary_budget - summary.curr.total)}円
            {overBudget && <span className="payroll-summary__over"> 超過!</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Salary row ──────────────────────────────────────────────────────

function SalaryRow({
  employee, periods, expanded, records, grades, recentEdits, canEdit, onSave,
  onCareerTrackChange, setToast,
}: {
  employee: EmployeeRow;
  periods: PeriodRow[];
  expanded: Set<PeriodCode>;
  records: Record<string, SalaryRecordRow>;
  grades: GradeRow[];
  recentEdits: Record<string, { at: number }>;
  canEdit: boolean;
  onSave: ReturnType<typeof usePayrollStore.getState>["upsertSalaryRecord"];
  onCareerTrackChange: ReturnType<typeof usePayrollStore.getState>["setEmployeeCareerTrack"];
  setToast: (t: { kind: "info" | "error"; message: string }) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const isRetired = !!employee.left_at && employee.left_at <= today;
  return (
    <tr className={isRetired ? "is-inactive" : ""}>
      <td className="salary-table__fixed"><code>{employee.employee_number}</code></td>
      <td className="salary-table__fixed">{employee.full_name ?? "—"}</td>
      <td className="salary-table__fixed">{employee.employment_type ?? "—"}</td>
      <td className="salary-table__fixed">{employee.department ?? "—"}</td>
      <td className="salary-table__fixed">
        {employee.position_title ?? "—"}
        {canEdit && (
          <CareerTrackBadge
            employee={employee}
            onChange={onCareerTrackChange}
            setToast={setToast}
          />
        )}
      </td>
      {periods.map((p) => (
        <SalaryCell
          key={p.code}
          employee={employee}
          period={p}
          expanded={expanded.has(p.code)}
          record={getRecord(records, employee.employee_number, p.code)}
          grades={grades}
          highlighted={isRecentlyEdited(recentEdits, employee.employee_number, p.code)}
          canEdit={canEdit}
          onSave={onSave}
          setToast={setToast}
        />
      ))}
    </tr>
  );
}

// ── Career track badge (inline editable) ────────────────────────────

function CareerTrackBadge({
  employee, onChange, setToast,
}: {
  employee: EmployeeRow;
  onChange: (employee_number: string, track: CareerTrack | null) => Promise<{ ok: boolean; reason?: string }>;
  setToast: (t: { kind: "info" | "error"; message: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <button
        className={`salary-table__trackBadge salary-table__trackBadge--${employee.career_track ?? "unset"}`}
        title="クリックでトラック変更"
        onClick={() => setEditing(true)}
      >
        {employee.career_track ? CAREER_TRACK_LABEL[employee.career_track] : "未割当"}
      </button>
    );
  }
  return (
    <select
      className="salary-table__trackSelect"
      autoFocus
      value={employee.career_track ?? ""}
      onChange={async (e) => {
        const v = e.target.value as CareerTrack | "";
        const res = await onChange(employee.employee_number, v || null);
        if (!res.ok) {
          setToast({ kind: "error", message: res.reason ?? "更新失敗" });
        } else {
          setToast({ kind: "info", message: "トラックを更新しました（リロードで反映）" });
        }
        setEditing(false);
      }}
      onBlur={() => setEditing(false)}
    >
      <option value="">未割当</option>
      <option value="management">マネジメント</option>
      <option value="specialist">スペシャリスト</option>
      <option value="diverse">多様な正社員</option>
    </select>
  );
}

// ── Salary cell (per employee × period) ─────────────────────────────

const DEBOUNCE_MS = 600;

function SalaryCell({
  employee, period, expanded, record, grades, highlighted, canEdit, onSave, setToast,
}: {
  employee: EmployeeRow;
  period: PeriodRow;
  expanded: boolean;
  record: SalaryRecordRow | null;
  grades: GradeRow[];
  highlighted: boolean;
  canEdit: boolean;
  onSave: ReturnType<typeof usePayrollStore.getState>["upsertSalaryRecord"];
  setToast: (t: { kind: "info" | "error"; message: string }) => void;
}) {
  // Local draft mirrors record. Debounced save propagates to DB.
  const [grade, setGrade] = useState<string | null>(record?.grade_code ?? null);
  const [base, setBase] = useState<string>(
    record?.base_salary != null ? String(record.base_salary) : "",
  );
  const [oa, setOa] = useState<string>(
    record?.fixed_overtime_allowance != null ? String(record.fixed_overtime_allowance) : "",
  );
  const [evalGrade, setEvalGrade] = useState<EvaluationGrade | null>(record?.evaluation_grade ?? null);
  const [comment, setComment] = useState<string>(record?.comment ?? "");
  const debounceRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);

  // Sync from server when record changes (and we're not actively editing)
  const docVersion = record?.updated_at ?? "";
  useEffect(() => {
    if (debounceRef.current) return;  // ongoing local edit
    setGrade(record?.grade_code ?? null);
    setBase(record?.base_salary != null ? String(record.base_salary) : "");
    setOa(record?.fixed_overtime_allowance != null ? String(record.fixed_overtime_allowance) : "");
    setEvalGrade(record?.evaluation_grade ?? null);
    setComment(record?.comment ?? "");
  }, [docVersion, record]);

  function scheduleSave(next: Partial<{
    grade_code: string | null;
    evaluation_grade: EvaluationGrade | null;
    base_salary: number | null;
    fixed_overtime_allowance: number | null;
    comment: string | null;
  }>) {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      debounceRef.current = null;
      setSaving(true);
      const res = await onSave({
        employee_number: employee.employee_number,
        period: period.code,
        grade_code: next.grade_code !== undefined ? next.grade_code : (grade ?? null),
        career_track: employee.career_track ?? null,
        evaluation_grade: next.evaluation_grade !== undefined ? next.evaluation_grade : (evalGrade ?? null),
        base_salary: next.base_salary !== undefined ? next.base_salary : (base ? Number(base) : null),
        fixed_overtime_allowance: next.fixed_overtime_allowance !== undefined ? next.fixed_overtime_allowance : (oa ? Number(oa) : null),
        comment: next.comment !== undefined ? next.comment : comment,
      });
      setSaving(false);
      if (!res.ok) {
        setToast({ kind: "error", message: res.reason ?? "保存失敗" });
      }
    }, DEBOUNCE_MS);
  }

  const total = (Number(base) || 0) + (Number(oa) || 0);
  const highlightCls = highlighted ? "is-highlighted" : "";

  if (!expanded) {
    // Collapsed: show etc + 月給 only, compact
    return (
      <td className={`salary-table__cell salary-table__cell--collapsed ${highlightCls}`}>
        {record ? (
          <div className="salary-table__compact">
            <span className="salary-table__compactGrade">{record.grade_code ?? "—"}</span>
            <span className="salary-table__compactMan">{fmtMan(record.total_monthly_salary)}</span>
          </div>
        ) : (
          <span className="salary-table__empty">—</span>
        )}
      </td>
    );
  }

  if (!canEdit) {
    return (
      <>
        <td className={`salary-table__cell ${highlightCls}`}>{record?.grade_code ?? "—"}</td>
        <td className={`salary-table__cell salary-table__cell--num ${highlightCls}`}>{fmtYen(record?.total_monthly_salary ?? 0)}</td>
        <td className={`salary-table__cell ${highlightCls}`}>{record?.evaluation_grade ?? "—"}</td>
        <td className={`salary-table__cell salary-table__cell--comment ${highlightCls}`}>{record?.comment ?? ""}</td>
      </>
    );
  }

  // Editable cells
  return (
    <>
      <td className={`salary-table__cell ${highlightCls}`}>
        <select
          className="salary-table__input salary-table__input--grade"
          value={grade ?? ""}
          onChange={(e) => {
            const next = e.target.value || null;
            setGrade(next);
            scheduleSave({ grade_code: next });
          }}
        >
          <option value="">—</option>
          {grades
            .filter((g) => !g.career_track || g.career_track === employee.career_track || g.tier === "non_manager" || g.tier === "officer")
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((g) => (
              <option key={g.code} value={g.code}>{g.code} - {g.label}</option>
            ))}
        </select>
      </td>
      <td className={`salary-table__cell salary-table__cell--num ${highlightCls}`}>
        <div className="salary-table__moneyStack">
          <input
            className="salary-table__input salary-table__input--money"
            type="number"
            placeholder="基本"
            value={base}
            onChange={(e) => { setBase(e.target.value); scheduleSave({ base_salary: e.target.value ? Number(e.target.value) : null }); }}
            title="基本給(円)"
          />
          <input
            className="salary-table__input salary-table__input--money"
            type="number"
            placeholder="固残"
            value={oa}
            onChange={(e) => { setOa(e.target.value); scheduleSave({ fixed_overtime_allowance: e.target.value ? Number(e.target.value) : null }); }}
            title="固定残業手当(円)"
          />
          <div className="salary-table__moneyTotal" title="合計月額">{fmtMan(total)}</div>
          {saving && <span className="salary-table__savingDot" title="保存中" />}
        </div>
      </td>
      <td className={`salary-table__cell ${highlightCls}`}>
        <select
          className="salary-table__input salary-table__input--eval"
          value={evalGrade ?? ""}
          onChange={(e) => { const v = (e.target.value || null) as EvaluationGrade | null; setEvalGrade(v); scheduleSave({ evaluation_grade: v }); }}
        >
          <option value="">—</option>
          {EVAL_GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
        </select>
      </td>
      <td className={`salary-table__cell salary-table__cell--comment ${highlightCls}`}>
        <textarea
          className="salary-table__input salary-table__input--comment"
          rows={2}
          value={comment}
          onChange={(e) => { setComment(e.target.value); scheduleSave({ comment: e.target.value }); }}
          placeholder="評価コメント"
        />
      </td>
    </>
  );
}
