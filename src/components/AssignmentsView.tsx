import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import type { OrgNode, PersonRole } from "../lib/types";
import { ROLE_DESCRIPTIONS } from "../lib/types";
import type { EmployeeRow } from "../lib/supabase";

/* ───────────────────── Data shape ───────────────────── */

type AssignmentEntry = {
  node: OrgNode;
  path: string;
  pathSegments: string[];
  role: PersonRole;
  secondaryRole: PersonRole;
};

type Assignment = {
  /** Stable key — employeeNumber when linked, else node id of the primary. */
  key: string;
  name: string;
  nameSortKey: string;
  employeeNumber: string | null;
  primary: AssignmentEntry | null;
  concurrent: AssignmentEntry[];
  employeeMaster: EmployeeRow | null;
  /** Cached union of all dept names appearing in primary + concurrent paths. */
  deptSet: Set<string>;
  /** Cached union of all roles (primary + concurrent). */
  roleSet: Set<NonNullable<PersonRole>>;
};

/* ───────────────────── Helpers ───────────────────── */

function pathSegments(nodes: OrgNode[], node: OrgNode): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur: OrgNode | undefined = node.parentId
    ? byId.get(node.parentId)
    : undefined;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts;
}

function cleanName(s: string): string {
  return s.replace(/^\*+\s*/, "").trim();
}

function buildAssignments(nodes: OrgNode[], employees: EmployeeRow[]): Assignment[] {
  const empByNumber = new Map(employees.map((e) => [e.employee_number, e]));
  const placed = nodes.filter(
    (n) => n.kind === "person" && !n.isUnplaced && n.parentId !== null,
  );

  type Group = {
    key: string;
    employeeNumber: string | null;
    name: string;
    nodes: OrgNode[];
  };
  const groups = new Map<string, Group>();
  for (const n of placed) {
    const empNo = n.employeeNumber ?? null;
    const key = empNo ? `emp:${empNo}` : `name:${cleanName(n.name)}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, employeeNumber: empNo, name: cleanName(n.name), nodes: [] };
      groups.set(key, g);
    }
    g.nodes.push(n);
    if (!n.isConcurrent) g.name = cleanName(n.name);
  }

  const out: Assignment[] = [];
  for (const g of groups.values()) {
    const primaryNode = g.nodes.find((n) => !n.isConcurrent) ?? null;
    const concurrentNodes = g.nodes.filter((n) => n.id !== primaryNode?.id);
    const master = g.employeeNumber ? empByNumber.get(g.employeeNumber) ?? null : null;

    function entryFor(n: OrgNode): AssignmentEntry {
      const segs = pathSegments(nodes, n);
      return {
        node: n,
        path: segs.length ? segs.join(" / ") : "（未配置）",
        pathSegments: segs,
        role: n.roleLabel ?? null,
        secondaryRole: n.secondaryRoleLabel ?? null,
      };
    }

    const primary = primaryNode ? entryFor(primaryNode) : null;
    const concurrent = concurrentNodes.map(entryFor);

    const deptSet = new Set<string>();
    for (const e of [primary, ...concurrent]) {
      if (!e) continue;
      for (const seg of e.pathSegments) deptSet.add(seg);
    }

    const roleSet = new Set<NonNullable<PersonRole>>();
    for (const e of [primary, ...concurrent]) {
      if (e?.role) roleSet.add(e.role);
    }

    const displayName =
      master?.display_name?.trim() || master?.full_name?.trim() || g.name;
    out.push({
      key: g.key,
      name: displayName,
      nameSortKey: displayName.normalize("NFKC"),
      employeeNumber: g.employeeNumber,
      primary,
      concurrent,
      employeeMaster: master,
      deptSet,
      roleSet,
    });
  }

  // Default order: 氏名 ascending. Sorting is overridden by user choice
  // later but we still build the array in a stable, predictable order.
  out.sort((a, b) => a.nameSortKey.localeCompare(b.nameSortKey, "ja"));
  return out;
}

/* ───────────────────── Sort ───────────────────── */

type SortKey = "name" | "empno" | "primary" | "concurrent";
type SortDir = "asc" | "desc";

function sortValue(a: Assignment, key: SortKey): string | number {
  switch (key) {
    case "name":
      return a.nameSortKey;
    case "empno":
      // Empty empno sorts to the end on asc.
      return a.employeeNumber ?? "￿";
    case "primary":
      return a.primary?.path ?? "￿";
    case "concurrent":
      return a.concurrent.length;
  }
}

function compareAssignments(a: Assignment, b: Assignment, key: SortKey, dir: SortDir): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  let cmp: number;
  if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
  else cmp = String(av).localeCompare(String(bv), "ja");
  // Tie-break by name asc so the table never feels shuffled.
  if (cmp === 0) cmp = a.nameSortKey.localeCompare(b.nameSortKey, "ja");
  return dir === "asc" ? cmp : -cmp;
}

/* ───────────────────── Filter popover ───────────────────── */

function FilterPopover({
  label,
  options,
  selected,
  onChange,
  formatOption,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  formatOption?: (opt: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (!ref.current?.contains(e.target as globalThis.Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      (formatOption?.(o) ?? o).toLowerCase().includes(q),
    );
  }, [options, query, formatOption]);

  function toggle(opt: string) {
    const next = new Set(selected);
    if (next.has(opt)) next.delete(opt);
    else next.add(opt);
    onChange(next);
  }

  function clear() {
    onChange(new Set());
  }

  const summary =
    selected.size === 0
      ? `${label}：すべて`
      : `${label}：${selected.size}件選択中`;

  return (
    <div className="filterpop" ref={ref}>
      <button
        type="button"
        className={`filterpop__trigger ${selected.size > 0 ? "is-active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        {summary}
        <span aria-hidden style={{ marginLeft: 6 }}>▾</span>
      </button>
      {open && (
        <div className="filterpop__panel" role="dialog">
          <input
            className="field__input field__input--xs filterpop__search"
            placeholder={`${label}内を絞り込み`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="filterpop__list">
            {filteredOptions.length === 0 ? (
              <p className="filterpop__empty">該当なし</p>
            ) : (
              filteredOptions.map((opt) => (
                <label key={opt} className="filterpop__row">
                  <input
                    type="checkbox"
                    checked={selected.has(opt)}
                    onChange={() => toggle(opt)}
                  />
                  <span>{formatOption?.(opt) ?? opt}</span>
                </label>
              ))
            )}
          </div>
          <div className="filterpop__footer">
            <button
              type="button"
              className="btn btn--ghost btn--xs"
              onClick={clear}
              disabled={selected.size === 0}
            >
              選択解除
            </button>
            <button
              type="button"
              className="btn btn--xs"
              onClick={() => setOpen(false)}
            >
              閉じる
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────────────── Main view ───────────────────── */

export function AssignmentsView() {
  const nodes = useOrgStore((s) => s.nodes);
  const setSelected = useOrgStore((s) => s.setSelected);
  const employees = useEmployeesStore((s) => s.employees);

  const [nameQuery, setNameQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState<Set<string>>(new Set());
  const [roleFilter, setRoleFilter] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const assignments = useMemo(() => buildAssignments(nodes, employees), [nodes, employees]);

  // Distinct option lists for the dept / role multi-selects, derived from
  // the data so users only see filters that match something.
  const allDepts = useMemo(() => {
    const s = new Set<string>();
    for (const a of assignments) for (const d of a.deptSet) s.add(d);
    return [...s].sort((x, y) => x.localeCompare(y, "ja"));
  }, [assignments]);

  const allRoles = useMemo(() => {
    const s = new Set<string>();
    for (const a of assignments) for (const r of a.roleSet) s.add(r);
    return [...s];
  }, [assignments]);

  const filtered = useMemo(() => {
    const q = nameQuery.trim().toLowerCase();
    return assignments.filter((a) => {
      if (q) {
        // Name-only search — dept/role have their own filters.
        const blob = [a.name, a.employeeNumber].filter(Boolean).join(" ").toLowerCase();
        if (!blob.includes(q)) return false;
      }
      if (deptFilter.size > 0) {
        let ok = false;
        for (const d of deptFilter) {
          if (a.deptSet.has(d)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      if (roleFilter.size > 0) {
        let ok = false;
        for (const r of roleFilter) {
          if (a.roleSet.has(r as NonNullable<PersonRole>)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      return true;
    });
  }, [assignments, nameQuery, deptFilter, roleFilter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    out.sort((a, b) => compareAssignments(a, b, sortKey, sortDir));
    return out;
  }, [filtered, sortKey, sortDir]);

  const totals = useMemo(() => {
    return {
      total: assignments.length,
      withConcurrent: assignments.filter((a) => a.concurrent.length > 0).length,
      withoutPrimary: assignments.filter((a) => !a.primary).length,
    };
  }, [assignments]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Default direction varies by column — names ascending, counts
      // descending feels right (most concurrent first).
      setSortDir(key === "concurrent" ? "desc" : "asc");
    }
  }

  function sortIndicator(key: SortKey): string {
    if (sortKey !== key) return "↕";
    return sortDir === "asc" ? "▲" : "▼";
  }

  const filterCount =
    (nameQuery.trim() ? 1 : 0) + (deptFilter.size > 0 ? 1 : 0) + (roleFilter.size > 0 ? 1 : 0);

  return (
    <div className="assignlist">
      <header className="assignlist__head">
        <div>
          <h2 className="assignlist__title">配属一覧</h2>
          <p className="assignlist__sub">
            組織図に配置された全 {totals.total} 名 ／ 兼務あり {totals.withConcurrent} 名
            {totals.withoutPrimary > 0 && (
              <> ／ <span className="assignlist__warn">主務未設定 {totals.withoutPrimary} 名</span></>
            )}
            {filterCount > 0 && (
              <> ／ 表示 <strong>{sorted.length}</strong> 名</>
            )}
          </p>
        </div>
      </header>

      <div className="assignlist__filters">
        <input
          className="field__input assignlist__nameInput"
          placeholder="氏名 / 社員番号 で絞り込み"
          value={nameQuery}
          onChange={(e) => setNameQuery(e.target.value)}
        />
        <FilterPopover
          label="部署"
          options={allDepts}
          selected={deptFilter}
          onChange={setDeptFilter}
        />
        <FilterPopover
          label="役職"
          options={allRoles}
          selected={roleFilter}
          onChange={setRoleFilter}
          formatOption={(r) =>
            ROLE_DESCRIPTIONS[r as NonNullable<PersonRole>]
              ? `${r}（${ROLE_DESCRIPTIONS[r as NonNullable<PersonRole>]}）`
              : r
          }
        />
        {filterCount > 0 && (
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => {
              setNameQuery("");
              setDeptFilter(new Set());
              setRoleFilter(new Set());
            }}
          >
            すべての絞り込みを解除
          </button>
        )}
      </div>

      <div className="assignlist__tableWrap">
        <table className="assignlist__table">
          <thead>
            <tr>
              <th
                style={{ width: 220 }}
                className={`assignlist__sortable ${sortKey === "name" ? "is-sorted" : ""}`}
                onClick={() => toggleSort("name")}
              >
                氏名 <span className="assignlist__sortIcon">{sortIndicator("name")}</span>
              </th>
              <th
                style={{ width: 120 }}
                className={`assignlist__sortable ${sortKey === "empno" ? "is-sorted" : ""}`}
                onClick={() => toggleSort("empno")}
              >
                社員番号 <span className="assignlist__sortIcon">{sortIndicator("empno")}</span>
              </th>
              <th
                className={`assignlist__sortable ${sortKey === "primary" ? "is-sorted" : ""}`}
                onClick={() => toggleSort("primary")}
              >
                主務（部署 ／ 役職） <span className="assignlist__sortIcon">{sortIndicator("primary")}</span>
              </th>
              <th
                className={`assignlist__sortable ${sortKey === "concurrent" ? "is-sorted" : ""}`}
                onClick={() => toggleSort("concurrent")}
              >
                兼務 <span className="assignlist__sortIcon">{sortIndicator("concurrent")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={4} className="assignlist__empty">
                  {assignments.length === 0
                    ? "組織図に人員が配置されていません。"
                    : "条件に一致する配属がありません。"}
                </td>
              </tr>
            ) : (
              sorted.map((a) => (
                <tr key={a.key}>
                  <td className="assignlist__name">
                    {a.primary ? (
                      <button
                        className="assignlist__nameBtn"
                        onClick={() => setSelected(a.primary!.node.id)}
                        title="主務ノードを選択"
                      >
                        {a.name}
                      </button>
                    ) : (
                      <span>{a.name}</span>
                    )}
                    {a.employeeMaster && (
                      <div className="assignlist__sub2">
                        {a.employeeMaster.department && <>{a.employeeMaster.department}</>}
                        {a.employeeMaster.employment_type && (
                          <> ・ {a.employeeMaster.employment_type}</>
                        )}
                      </div>
                    )}
                  </td>
                  <td>
                    {a.employeeNumber ? (
                      <code>{a.employeeNumber}</code>
                    ) : (
                      <span className="assignlist__muted">未紐付</span>
                    )}
                  </td>
                  <td>
                    {a.primary ? (
                      <div className="assignlist__cell">
                        <span className="assignlist__path">{a.primary.path}</span>
                        {a.primary.role && (
                          <span className="assignlist__role">
                            {a.primary.role}
                            {a.primary.secondaryRole && <> 兼 {a.primary.secondaryRole}</>}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="assignlist__warn">主務ノード未設定</span>
                    )}
                  </td>
                  <td>
                    {a.concurrent.length === 0 ? (
                      <span className="assignlist__muted">—</span>
                    ) : (
                      <ul className="assignlist__concurrentList">
                        {a.concurrent.map((c) => (
                          <li key={c.node.id}>
                            <button
                              className="assignlist__pathBtn"
                              onClick={() => setSelected(c.node.id)}
                              title="このノードを選択"
                            >
                              <span className="assignlist__path">{c.path}</span>
                              {c.role && (
                                <span className="assignlist__role assignlist__role--concurrent">
                                  {c.role}
                                  {c.secondaryRole && <> 兼 {c.secondaryRole}</>}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
