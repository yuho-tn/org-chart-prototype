import { useEffect, useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import {
  useEmployeesStore,
  activeEmployees,
  isCasualEmployment,
} from "../store/useEmployeesStore";
import { useUiStore } from "../store/useUiStore";
import { useOrgLock, selectLockReadOnly } from "../store/useOrgLock";
import { isSupabaseConfigured, employeeName } from "../lib/supabase";
import { STORAGE_KEYS, readStorage, writeStorage } from "../lib/storageKeys";

/** 雇用形態フィルタの3モード（P2: 要件定義書 §6-3）。 */
type EmpTypeMode = "staff" | "casual" | "both";

type UnplacedFilterState = { empTypeMode: EmpTypeMode; departments: string[] };

function readFilterState(): UnplacedFilterState {
  try {
    const raw = readStorage(STORAGE_KEYS.unplacedFilters);
    if (raw) {
      const p = JSON.parse(raw) as Partial<UnplacedFilterState>;
      return {
        empTypeMode:
          p.empTypeMode === "casual" || p.empTypeMode === "both" ? p.empTypeMode : "staff",
        departments: Array.isArray(p.departments)
          ? p.departments.filter((d): d is string => typeof d === "string")
          : [],
      };
    }
  } catch {
    // fall through
  }
  return { empTypeMode: "staff", departments: [] };
}

function writeFilterState(st: UnplacedFilterState) {
  writeStorage(STORAGE_KEYS.unplacedFilters, JSON.stringify(st));
}

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
  const navigate = useUiStore((s) => s.navigate);

  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  // P2: 雇用形態は「社員のみ / アルバイト・インターンのみ / 両方」の3択、
  // さらに部署（マスターの所属）で複数絞り込みできる。用途例:
  // インターン組織図→casual、SNS組織図→部署で SNS DIV / Instagram TM。
  // 状態はユーザー毎に localStorage 保持。
  const [{ empTypeMode, departments: deptFilter }, setFilters] =
    useState<UnplacedFilterState>(readFilterState);
  function updateFilters(patch: Partial<UnplacedFilterState>) {
    setFilters((prev) => {
      const next = { ...prev, ...patch };
      writeFilterState(next);
      return next;
    });
  }
  // P2: 編集ロック非保持（閲覧モード）の間は追加操作を無効化する。
  const lockReadOnly = useOrgLock(selectLockReadOnly);
  // Same employee can be referenced from many person nodes (兼務). When
  // ON, the panel keeps already-placed employees in the list so the user
  // can add a 兼務 entry for them; when OFF (default) we hide them as
  // before to keep the list short.
  const [includePlaced, setIncludePlaced] = useState(false);

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

  // 部署の選択肢（在籍者の所属ユニーク値）
  const departmentOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of activeEmployees(employees)) {
      if (e.department) set.add(e.department);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "ja"));
  }, [employees]);

  const candidates = useMemo(() => {
    const active = activeEmployees(employees);
    const q = filter.trim().toLowerCase();
    return active
      .filter((e) => includePlaced || !placed.has(e.employee_number))
      .filter((e) => {
        if (empTypeMode === "both") return true;
        const casual = isCasualEmployment(e.employment_type);
        return empTypeMode === "casual" ? casual : !casual;
      })
      .filter(
        (e) =>
          deptFilter.length === 0 ||
          (e.department != null && deptFilter.includes(e.department)),
      )
      .filter((e) => {
        if (!q) return true;
        const blob = [
          e.full_name,
          e.display_name,
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
  }, [employees, placed, filter, empTypeMode, deptFilter, includePlaced]);

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
                onClick={() => navigate({ name: "employees" })}
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
              <div className="unplaced__seg" role="tablist" aria-label="雇用形態で絞り込み">
                {(
                  [
                    ["staff", "社員"],
                    ["casual", "バイト・イン"],
                    ["both", "両方"],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    role="tab"
                    aria-selected={empTypeMode === mode}
                    className={`unplaced__segBtn ${empTypeMode === mode ? "is-active" : ""}`}
                    onClick={() => updateFilters({ empTypeMode: mode })}
                    title={
                      mode === "staff"
                        ? "社員のみ表示"
                        : mode === "casual"
                          ? "アルバイト・インターンのみ表示"
                          : "全雇用形態を表示"
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>
              <select
                className="field__input field__input--xs"
                value=""
                onChange={(e) => {
                  const d = e.target.value;
                  if (d && !deptFilter.includes(d)) {
                    updateFilters({ departments: [...deptFilter, d] });
                  }
                }}
                title="部署（マスターの所属）で絞り込み"
              >
                <option value="">＋部署で絞り込み…</option>
                {departmentOptions
                  .filter((d) => !deptFilter.includes(d))
                  .map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
              </select>
              {deptFilter.length > 0 && (
                <div className="unplaced__chips">
                  {deptFilter.map((d) => (
                    <button
                      key={d}
                      className="unplaced__chip"
                      onClick={() =>
                        updateFilters({
                          departments: deptFilter.filter((x) => x !== d),
                        })
                      }
                      title="クリックで解除"
                    >
                      {d} ✕
                    </button>
                  ))}
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => updateFilters({ departments: [] })}
                  >
                    クリア
                  </button>
                </div>
              )}
              <label className="checkbox unplaced__toggle">
                <input
                  type="checkbox"
                  checked={includePlaced}
                  onChange={(e) => setIncludePlaced(e.target.checked)}
                />
                <span>
                  配置済みも表示（兼務として再追加するとき）
                </span>
              </label>
              {candidates.length === 0 ? (
                <p className="unplaced__empty">
                  {deptFilter.length > 0 || empTypeMode !== "staff"
                    ? "条件に一致する未配置メンバーがいません。"
                    : "在籍中の従業員はすべて組織図に配置済みです。"}
                </p>
              ) : (
                <ul className="unplaced__list">
                  {candidates.slice(0, 50).map((e) => {
                    const fullName = employeeName(e);
                    const isPlaced = placed.has(e.employee_number);
                    return (
                      <li
                        key={e.employee_number}
                        className={`unplaced__item ${isPlaced ? "is-placed" : ""}`}
                      >
                        <div className="unplaced__name">
                          {fullName}
                          {isPlaced && (
                            <span className="unplaced__placedBadge" title="既に組織図に配置されています">配置済</span>
                          )}
                        </div>
                        <div className="unplaced__meta">
                          <code>{e.employee_number}</code>
                          {e.department && <span>・{e.department}</span>}
                          {e.position_title && <span>・{e.position_title}</span>}
                        </div>
                        <button
                          className="btn btn--xs"
                          disabled={lockReadOnly}
                          onClick={() =>
                            addPersonFromEmployee({
                              employee_number: e.employee_number,
                              name: fullName,
                            })
                          }
                          title={
                            isPlaced
                              ? "兼務として未配置に追加（自動で兼務フラグON）"
                              : "未配置エリアに追加 → ドラッグで配置"
                          }
                        >
                          {isPlaced ? "＋兼務追加" : "＋追加"}
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
