import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import type { OrgNode, PersonRole } from "../lib/types";
import type { EmployeeRow } from "../lib/supabase";

/**
 * Aggregate of all chart positions held by a single person. Built once per
 * render from the placed person nodes; the same employee may have one
 * primary (主務) and any number of concurrent (兼務) entries — exactly the
 * shape the user wants the table to surface.
 */
type Assignment = {
  /** Stable key — employeeNumber when linked, else node id of the primary. */
  key: string;
  name: string;
  employeeNumber: string | null;
  primary: { node: OrgNode; path: string; role: PersonRole } | null;
  concurrent: { node: OrgNode; path: string; role: PersonRole }[];
  employeeMaster: EmployeeRow | null;
};

function pathOfParents(nodes: OrgNode[], node: OrgNode): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur: OrgNode | undefined = node.parentId
    ? byId.get(node.parentId)
    : undefined;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" / ") || "（未配置）";
}

/**
 * Strip the leading "*" that 兼務 chips carry as a visual marker. Two chips
 * for the same person otherwise show as different names in this view.
 */
function cleanName(s: string): string {
  return s.replace(/^\*+\s*/, "").trim();
}

/**
 * Build the assignment rows. Group person nodes by employeeNumber when
 * present (兼務 use case shares an employee_number across nodes), and fall
 * back to a normalized name for nodes that aren't linked yet so they still
 * show up. Only placed nodes (parent set, not unplaced) are counted —
 * unplaced tray entries aren't "配属" yet.
 */
function buildAssignments(
  nodes: OrgNode[],
  employees: EmployeeRow[],
): Assignment[] {
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
    // Prefer the primary (non-concurrent) node's name as the group label.
    if (!n.isConcurrent) g.name = cleanName(n.name);
  }

  const out: Assignment[] = [];
  for (const g of groups.values()) {
    const primaryNode = g.nodes.find((n) => !n.isConcurrent) ?? null;
    const concurrentNodes = g.nodes.filter((n) => n.id !== primaryNode?.id);
    const master = g.employeeNumber
      ? empByNumber.get(g.employeeNumber) ?? null
      : null;
    out.push({
      key: g.key,
      name: master?.full_name?.trim() || g.name,
      employeeNumber: g.employeeNumber,
      primary: primaryNode
        ? {
            node: primaryNode,
            path: pathOfParents(nodes, primaryNode),
            role: primaryNode.roleLabel ?? null,
          }
        : null,
      concurrent: concurrentNodes.map((n) => ({
        node: n,
        path: pathOfParents(nodes, n),
        role: n.roleLabel ?? null,
      })),
      employeeMaster: master,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name, "ja"));
  return out;
}

export function AssignmentsView() {
  const nodes = useOrgStore((s) => s.nodes);
  const setSelected = useOrgStore((s) => s.setSelected);
  const employees = useEmployeesStore((s) => s.employees);

  const [filter, setFilter] = useState("");

  const assignments = useMemo(() => buildAssignments(nodes, employees), [nodes, employees]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return assignments;
    return assignments.filter((a) => {
      const blob = [
        a.name,
        a.employeeNumber,
        a.primary?.path,
        a.primary?.role,
        a.employeeMaster?.department,
        a.employeeMaster?.position_title,
        a.employeeMaster?.employment_type,
        ...a.concurrent.map((c) => c.path),
        ...a.concurrent.map((c) => c.role ?? ""),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });
  }, [assignments, filter]);

  // Header counts so users can see "X people placed, of whom Y have 兼務"
  // at a glance.
  const totals = useMemo(() => {
    return {
      total: assignments.length,
      withConcurrent: assignments.filter((a) => a.concurrent.length > 0).length,
      withoutPrimary: assignments.filter((a) => !a.primary).length,
    };
  }, [assignments]);

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
          </p>
        </div>
        <input
          className="field__input assignlist__filter"
          placeholder="氏名 / 部署 / 役職 / 社員番号 で絞り込み"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </header>

      <div className="assignlist__tableWrap">
        <table className="assignlist__table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>氏名</th>
              <th style={{ width: 110 }}>社員番号</th>
              <th>主務（部署 ／ 役職）</th>
              <th>兼務</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="assignlist__empty">
                  {assignments.length === 0
                    ? "組織図に人員が配置されていません。"
                    : "条件に一致する配属がありません。"}
                </td>
              </tr>
            ) : (
              filtered.map((a) => (
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
                          <span className="assignlist__role">{a.primary.role}</span>
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
