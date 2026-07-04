import { useEffect, useMemo, useState } from "react";
import { usePayrollStore } from "../../store/usePayrollStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import type { SalaryAuditLogRow } from "../../lib/supabase";

const TABLE_LABEL: Record<string, string> = {
  salary_records: "給与レコード",
  grades: "等級マスター",
  periods: "期マスター",
};

const OP_LABEL: Record<string, string> = {
  INSERT: "新規追加",
  UPDATE: "更新",
  DELETE: "削除",
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

/** Compute a list of changed fields between before/after JSON objects. */
function diffFields(before: Record<string, unknown> | null, after: Record<string, unknown> | null): { field: string; before: unknown; after: unknown }[] {
  if (!before && !after) return [];
  if (!before) return Object.entries(after ?? {}).map(([field, value]) => ({ field, before: null, after: value }));
  if (!after) return Object.entries(before).map(([field, value]) => ({ field, before: value, after: null }));
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const ignore = new Set(["updated_at", "created_at"]);
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const k of keys) {
    if (ignore.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out.push({ field: k, before: before[k], after: after[k] });
    }
  }
  return out;
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * 給与系の変更履歴を時系列で表示。salary_audit_log を最新200件まで読み、
 * 差分を「変更前 → 変更後」で並べる。給与レコードについては、社員番号→
 * 氏名へ解決する。
 */
export function AuditLogPage() {
  const auditLog = usePayrollStore((s) => s.auditLog);
  const auditLoading = usePayrollStore((s) => s.auditLoading);
  const auditError = usePayrollStore((s) => s.auditError);
  const refreshAuditLog = usePayrollStore((s) => s.refreshAuditLog);
  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);

  const [tableFilter, setTableFilter] = useState<string>("");
  const [opFilter, setOpFilter] = useState<string>("");
  const [actorFilter, setActorFilter] = useState<string>("");

  useEffect(() => { refreshAuditLog(); }, [refreshAuditLog]);
  useEffect(() => { refreshEmployees(); }, [refreshEmployees]);

  const employeeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of employees) {
      const name = e.display_name?.trim() || e.full_name;
      if (name) map.set(e.employee_number, name);
    }
    return map;
  }, [employees]);

  const filtered = useMemo(() => {
    return auditLog.filter((row) => {
      if (tableFilter && row.table_name !== tableFilter) return false;
      if (opFilter && row.operation !== opFilter) return false;
      if (actorFilter && !(row.actor_email ?? "").includes(actorFilter)) return false;
      return true;
    });
  }, [auditLog, tableFilter, opFilter, actorFilter]);

  const distinctActors = useMemo(
    () => [...new Set(auditLog.map((r) => r.actor_email).filter(Boolean) as string[])].sort(),
    [auditLog],
  );

  function targetLabel(row: SalaryAuditLogRow): string {
    if (row.table_name === "salary_records") {
      // pull employee_number from before/after if available
      const v = (row.after_value ?? row.before_value) as Record<string, unknown> | null;
      const empNum = v?.employee_number as string | undefined;
      const period = v?.period as string | undefined;
      const name = empNum ? employeeNameMap.get(empNum) : null;
      return [empNum, name, period].filter(Boolean).join(" / ");
    }
    return row.row_id;
  }

  return (
    <main className="page payroll-page">
      <div className="page__header">
        <div>
          <h1 className="page__title">監査ログ</h1>
          <p className="page__subtitle">
            給与・等級・期マスターへのすべての変更を時系列で記録。最新 {auditLog.length} 件を表示中（最大200件まで）。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--ghost btn--xs" onClick={() => refreshAuditLog()}>再読み込み</button>
        </div>
      </div>

      {auditError && <p className="versions__error">{auditError}</p>}

      <div className="emppage__filters">
        <select className="field__input" value={tableFilter} onChange={(e) => setTableFilter(e.target.value)}>
          <option value="">対象テーブル：全て</option>
          {Object.entries(TABLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="field__input" value={opFilter} onChange={(e) => setOpFilter(e.target.value)}>
          <option value="">操作：全て</option>
          {Object.entries(OP_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="field__input" value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
          <option value="">変更者：全て</option>
          {distinctActors.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <span className="emppage__count"><strong>{filtered.length}</strong> 件</span>
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table audit-table">
          <thead>
            <tr>
              <th style={{ width: 160 }}>日時</th>
              <th style={{ width: 110 }}>対象</th>
              <th style={{ width: 80 }}>操作</th>
              <th style={{ width: 260 }}>対象行</th>
              <th>変更内容</th>
              <th style={{ width: 200 }}>変更者</th>
            </tr>
          </thead>
          <tbody>
            {auditLoading && (
              <tr><td colSpan={6} className="usermgr__empty">読み込み中…</td></tr>
            )}
            {!auditLoading && filtered.length === 0 && (
              <tr><td colSpan={6} className="usermgr__empty">該当する履歴がありません</td></tr>
            )}
            {filtered.map((row) => {
              const diffs = diffFields(row.before_value, row.after_value);
              return (
                <tr key={row.id}>
                  <td><code>{fmtTime(row.changed_at)}</code></td>
                  <td>{TABLE_LABEL[row.table_name] ?? row.table_name}</td>
                  <td>
                    <span className={`audit-table__op audit-table__op--${row.operation.toLowerCase()}`}>
                      {OP_LABEL[row.operation] ?? row.operation}
                    </span>
                  </td>
                  <td>{targetLabel(row)}</td>
                  <td>
                    {diffs.length === 0 ? <span className="usermgr__empty">（差分なし）</span> : (
                      <ul className="audit-table__diffList">
                        {diffs.map((d) => (
                          <li key={d.field}>
                            <code>{d.field}</code>:{" "}
                            <span className="audit-table__before">{fmtValue(d.before)}</span>
                            {" → "}
                            <span className="audit-table__after">{fmtValue(d.after)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td><code>{row.actor_email ?? "—"}</code></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
