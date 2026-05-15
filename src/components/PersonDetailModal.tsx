import { useEffect, useMemo } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { ROLE_DESCRIPTIONS, type OrgNode } from "../lib/types";

/**
 * Viewer-mode-only modal: when a person chip/exec card is clicked the
 * selectedId in useOrgStore changes; this component watches that and pops
 * up a read-only detail card listing the person's primary (主務) and
 * concurrent (兼務) department assignments. Employee-master fields
 * (社員番号 / 役職 / 雇用形態 / 入社日) are shown when the node is linked.
 */

function cleanName(s: string): string {
  return s.replace(/^\*+\s*/, "").trim();
}

function pathSegments(byId: Map<string, OrgNode>, node: OrgNode): string[] {
  const parts: string[] = [];
  let cur: OrgNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts;
}

export function PersonDetailModal() {
  const selectedId = useOrgStore((s) => s.selectedId);
  const setSelected = useOrgStore((s) => s.setSelected);
  const nodes = useOrgStore((s) => s.nodes);
  const employees = useEmployeesStore((s) => s.employees);

  const detail = useMemo(() => {
    if (!selectedId) return null;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const target = byId.get(selectedId);
    if (!target || target.kind !== "person") return null;

    // Group all nodes for the same person — by employeeNumber when linked,
    // else by name. Mirrors the logic in AssignmentsView.
    const empNo = target.employeeNumber ?? null;
    const key = empNo ? `emp:${empNo}` : `name:${cleanName(target.name)}`;
    const siblings = nodes.filter((n) => {
      if (n.kind !== "person" || n.isUnplaced) return false;
      const k = n.employeeNumber
        ? `emp:${n.employeeNumber}`
        : `name:${cleanName(n.name)}`;
      return k === key;
    });

    const primary = siblings.find((n) => !n.isConcurrent) ?? null;
    const concurrent = siblings.filter((n) => n.id !== primary?.id);

    const master = empNo ? employees.find((e) => e.employee_number === empNo) ?? null : null;
    const displayName = master?.full_name?.trim() || cleanName(target.name);

    function entryFor(n: OrgNode) {
      const segs = pathSegments(byId, n);
      return {
        id: n.id,
        path: segs.length ? segs.join(" / ") : "（未配置）",
        role: n.roleLabel ?? null,
        secondaryRole: n.secondaryRoleLabel ?? null,
        isExecutive: !!n.isExecutive,
      };
    }

    return {
      name: displayName,
      employeeNumber: empNo,
      master,
      primary: primary ? entryFor(primary) : null,
      concurrent: concurrent.map(entryFor),
    };
  }, [selectedId, nodes, employees]);

  // Close on Escape. The backdrop click and × button do the same via
  // setSelected(null).
  useEffect(() => {
    if (!detail) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [detail, setSelected]);

  if (!detail) return null;

  const close = () => setSelected(null);

  return (
    <div
      className="modal-backdrop"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label={`${detail.name} の所属詳細`}
    >
      <div className="modal person-detail" onClick={(e) => e.stopPropagation()}>
        <div className="person-detail__head">
          <h3 className="modal__title">{detail.name}</h3>
          <button
            className="person-detail__close"
            onClick={close}
            aria-label="閉じる"
            title="閉じる"
          >
            ×
          </button>
        </div>

        {(detail.employeeNumber || detail.master) && (
          <dl className="person-detail__meta">
            {detail.employeeNumber && (
              <>
                <dt>社員番号</dt>
                <dd>
                  <code>{detail.employeeNumber}</code>
                </dd>
              </>
            )}
            {detail.master?.position_title && (
              <>
                <dt>役職</dt>
                <dd>{detail.master.position_title}</dd>
              </>
            )}
            {detail.master?.department && (
              <>
                <dt>マスター部署</dt>
                <dd>{detail.master.department}</dd>
              </>
            )}
            {detail.master?.employment_type && (
              <>
                <dt>雇用形態</dt>
                <dd>{detail.master.employment_type}</dd>
              </>
            )}
            {detail.master?.hired_at && (
              <>
                <dt>入社日</dt>
                <dd>{detail.master.hired_at}</dd>
              </>
            )}
          </dl>
        )}

        {!detail.employeeNumber && (
          <p className="person-detail__warn">
            このノードは従業員マスターと紐付いていません。
          </p>
        )}

        <section className="person-detail__section">
          <h4 className="person-detail__heading">主務</h4>
          {detail.primary ? (
            <AssignmentRow
              path={detail.primary.path}
              role={detail.primary.role}
              secondaryRole={detail.primary.secondaryRole}
              isExecutive={detail.primary.isExecutive}
            />
          ) : (
            <p className="person-detail__muted">主務ノードが設定されていません。</p>
          )}
        </section>

        <section className="person-detail__section">
          <h4 className="person-detail__heading">
            兼務
            {detail.concurrent.length > 0 && (
              <span className="person-detail__count">{detail.concurrent.length}</span>
            )}
          </h4>
          {detail.concurrent.length === 0 ? (
            <p className="person-detail__muted">兼務はありません。</p>
          ) : (
            <ul className="person-detail__list">
              {detail.concurrent.map((c) => (
                <li key={c.id}>
                  <AssignmentRow
                    path={c.path}
                    role={c.role}
                    secondaryRole={c.secondaryRole}
                    isExecutive={c.isExecutive}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="modal__actions">
          <button className="btn" onClick={close}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

function AssignmentRow({
  path,
  role,
  secondaryRole,
  isExecutive,
}: {
  path: string;
  role: string | null;
  secondaryRole?: string | null;
  isExecutive: boolean;
}) {
  return (
    <div className="person-detail__row">
      <span className="person-detail__path">{path}</span>
      {role && (
        <span
          className="person-detail__role"
          title={
            secondaryRole
              ? `${ROLE_DESCRIPTIONS[role as keyof typeof ROLE_DESCRIPTIONS]} 兼 ${ROLE_DESCRIPTIONS[secondaryRole as keyof typeof ROLE_DESCRIPTIONS]}`
              : ROLE_DESCRIPTIONS[role as keyof typeof ROLE_DESCRIPTIONS]
          }
        >
          {role}
          {secondaryRole && <> 兼 {secondaryRole}</>}
        </span>
      )}
      {isExecutive && <span className="person-detail__badge">役員</span>}
    </div>
  );
}
