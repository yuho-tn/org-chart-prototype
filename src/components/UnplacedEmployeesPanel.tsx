import { useEffect, useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore, activeEmployees } from "../store/useEmployeesStore";
import { useUiStore } from "../store/useUiStore";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * Sidebar panel listing employees from the master who are NOT yet referenced
 * by any person node in the current chart. Retired employees (left_at <= today)
 * are excluded automatically. One click adds the employee to the tray so the
 * user can drag them into position.
 */
export function UnplacedEmployeesPanel() {
  const employees = useEmployeesStore((s) => s.employees);
  const refresh = useEmployeesStore((s) => s.refresh);
  const error = useEmployeesStore((s) => s.error);
  const nodes = useOrgStore((s) => s.nodes);
  const addPersonFromEmployee = useOrgStore((s) => s.addPersonFromEmployee);
  const setShowEmployees = useUiStore((s) => s.setShowEmployees);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (isSupabaseConfigured) refresh();
  }, [refresh]);

  // Set of employee_numbers already represented in the chart (placed only;
  // unplaced person nodes count too — we don't want to re-add them).
  const placed = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) {
      if (n.kind === "person" && n.employeeNumber) s.add(n.employeeNumber);
    }
    return s;
  }, [nodes]);

  const candidates = useMemo(() => {
    const active = activeEmployees(employees);
    const q = filter.trim().toLowerCase();
    return active
      .filter((e) => !placed.has(e.employee_number))
      .filter((e) => {
        if (!q) return true;
        const blob = [
          e.last_name,
          e.first_name,
          e.email,
          e.department,
          e.position_title,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      })
      .sort((a, b) => a.employee_number.localeCompare(b.employee_number));
  }, [employees, placed, filter]);

  if (!isSupabaseConfigured) return null;

  return (
    <section className="unplaced">
      <header className="unplaced__head">
        <h2 className="sidebar__title" style={{ margin: 0 }}>
          未配置メンバー
          <span className="unplaced__count">{candidates.length}</span>
        </h2>
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "開く" : "閉じる"}
        >
          {collapsed ? "▾" : "▴"}
        </button>
      </header>
      {!collapsed && (
        <>
          {error && <p className="versions__error">{error}</p>}
          {employees.length === 0 && !error && (
            <p className="unplaced__hint">
              従業員名簿が空です。
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => setShowEmployees(true)}
              >
                名簿を開く
              </button>
            </p>
          )}
          {employees.length > 0 && (
            <>
              <input
                className="field__input field__input--xs"
                placeholder="名前 / 部署で絞り込み"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {candidates.length === 0 ? (
                <p className="unplaced__empty">
                  在籍中の従業員はすべて組織図に配置済みです。
                </p>
              ) : (
                <ul className="unplaced__list">
                  {candidates.slice(0, 50).map((e) => {
                    const fullName = `${e.last_name ?? ""} ${e.first_name ?? ""}`.trim() || e.employee_number;
                    return (
                      <li key={e.employee_number} className="unplaced__item">
                        <div className="unplaced__name">{fullName}</div>
                        <div className="unplaced__meta">
                          <code>{e.employee_number}</code>
                          {e.department && <span>・{e.department}</span>}
                          {e.position_title && <span>・{e.position_title}</span>}
                        </div>
                        <button
                          className="btn btn--xs"
                          onClick={() =>
                            addPersonFromEmployee({
                              employee_number: e.employee_number,
                              name: fullName,
                            })
                          }
                          title="未配置エリアに追加 → ドラッグで配置"
                        >
                          ＋追加
                        </button>
                      </li>
                    );
                  })}
                  {candidates.length > 50 && (
                    <li className="unplaced__more">
                      …ほか {candidates.length - 50} 件（絞り込んでください）
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
