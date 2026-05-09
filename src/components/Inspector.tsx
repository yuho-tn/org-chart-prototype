import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { descendantsOf } from "../lib/layout";
import { ALL_ROLES, ROLE_DESCRIPTIONS } from "../lib/types";
import type { DeptCategory, OrgNode, PersonRole } from "../lib/types";
import { PALETTE } from "../lib/palette";
import { findEmployeeByName } from "../lib/employeeMatch";
import { EmployeeLinkDialog } from "./EmployeeLinkDialog";

const CATEGORIES: DeptCategory[] = ["ROOT", "Exe", "DIV", "TM", "Unit", "DEPT"];
const ROLES: { value: PersonRole; label: string }[] = [
  { value: null, label: "メンバー（役職なし）" },
  ...ALL_ROLES.map((r) => ({
    value: r as PersonRole,
    label: `${r}（${ROLE_DESCRIPTIONS[r]}）`,
  })),
];

/**
 * Build a "/"-separated path of all ancestors of `node`, optionally
 * skipping the leaf itself. The leaf is redundant in the inspector
 * because the chip name is already shown in the editable field above.
 */
function pathOf(nodes: OrgNode[], node: OrgNode, includeLeaf: boolean): string {
  const parts: string[] = [];
  let cur: OrgNode | undefined = node;
  while (cur) {
    if (cur === node && !includeLeaf) {
      cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined;
      continue;
    }
    parts.unshift(cur.name);
    cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined;
  }
  return parts.join(" / ") || "（未配置）";
}

/**
 * Given a person node, gather every other node that points at the same
 * employee_number — these are the 兼務 entries. The "primary" (主務) is
 * picked in this order:
 *   1. If the selected node itself is non-concurrent, it wins. This makes
 *      the inspector's "I just unchecked 兼務" expectation reliable even
 *      when stale orphan rows or pre-existing primaries are still around.
 *   2. Otherwise the first match with isConcurrent=false.
 *   3. Otherwise null (no primary anywhere).
 *
 * Orphan nodes (parentId=null, !isUnplaced) are excluded so they can't
 * silently outrank a real placed primary.
 */
function affiliationsOf(
  nodes: OrgNode[],
  selected: OrgNode,
): { primary: OrgNode | null; concurrent: OrgNode[] } {
  if (!selected.employeeNumber) {
    return {
      primary: selected.isConcurrent ? null : selected,
      concurrent: [],
    };
  }
  const matches = nodes.filter(
    (n) =>
      n.kind === "person" &&
      n.employeeNumber === selected.employeeNumber &&
      !n.isUnplaced &&
      n.parentId !== null,
  );
  const selectedQualifies =
    !selected.isConcurrent && !selected.isUnplaced && selected.parentId !== null;
  const primary: OrgNode | null = selectedQualifies
    ? selected
    : matches.find((n) => !n.isConcurrent) ?? null;
  const concurrent = matches.filter((n) => n.id !== primary?.id);
  return { primary, concurrent };
}

export function Inspector() {
  const nodes = useOrgStore((s) => s.nodes);
  const selectedId = useOrgStore((s) => s.selectedId);
  const rename = useOrgStore((s) => s.rename);
  const setRole = useOrgStore((s) => s.setRole);
  const setConcurrent = useOrgStore((s) => s.setConcurrent);
  const setEmployeeNumber = useOrgStore((s) => s.setEmployeeNumber);
  const setCategory = useOrgStore((s) => s.setCategory);
  const setColor = useOrgStore((s) => s.setColor);
  const deleteNode = useOrgStore((s) => s.deleteNode);

  const employees = useEmployeesStore((s) => s.employees);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const [name, setName] = useState(selected?.name ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  // IME 変換中は controlled value の上書き／commit を抑止する。
  // 入力中に value 再注入が走るとブラウザが確定済みテキストを再挿入し、
  // 「同じ文字が二重に入る」ように見える既知のバグを防ぐ。
  const composingRef = useRef(false);

  useEffect(() => {
    if (composingRef.current) return;
    setName(selected?.name ?? "");
  }, [selectedId, selected?.name]);

  // Resolve the linked employee record (if any) so we can show their full
  // metadata — department, position, employment_type — to the user.
  const linkedEmployee = useMemo(() => {
    if (!selected || selected.kind !== "person") return null;
    if (!selected.employeeNumber) return null;
    return (
      employees.find((e) => e.employee_number === selected.employeeNumber) ?? null
    );
  }, [employees, selected]);

  const affiliations = useMemo(() => {
    if (!selected || selected.kind !== "person") return null;
    return affiliationsOf(nodes, selected);
  }, [nodes, selected]);

  if (!selected) {
    return (
      <aside className="inspector inspector--empty">
        <h2 className="inspector__title">詳細</h2>
        <p>ノード（部署カードまたは人員チップ）を選択すると詳細が表示されます。</p>
      </aside>
    );
  }

  const descCount = descendantsOf(nodes, selected.id).length;

  function commitRename() {
    if (composingRef.current) return;
    if (selected && name.trim() && name !== selected.name) {
      rename(selected.id, name.trim());
    }
  }

  return (
    <>
      <aside className="inspector">
        <h2 className="inspector__title">詳細</h2>
        <div className={`badge badge--${selected.kind}`}>
          {selected.kind === "department" ? `部署 / ${selected.category ?? "DEPT"}` : "人員"}
        </div>
        <label className="field">
          <span className="field__label">名前</span>
          <input
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              setName((e.target as HTMLInputElement).value);
            }}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>

        {selected.kind === "department" && (
          <>
            <label className="field">
              <span className="field__label">種別</span>
              <select
                className="field__input"
                value={selected.category ?? "DEPT"}
                onChange={(e) => setCategory(selected.id, e.target.value as DeptCategory)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field__label">カラー</span>
              <div className="color-grid">
                {PALETTE.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`color-swatch ${selected.colorIndex === i ? "is-active" : ""}`}
                    style={{ background: c.header, borderColor: c.border }}
                    onClick={() => setColor(selected.id, i)}
                    aria-label={`色 ${i + 1}`}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {selected.kind === "person" && (
          <>
            <label className="field">
              <span className="field__label">役職</span>
              <select
                className="field__input"
                value={selected.roleLabel ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setRole(selected.id, v === "" ? null : (v as PersonRole));
                }}
              >
                {ROLES.map((r) => (
                  <option key={r.label} value={r.value ?? ""}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span className="field__label">兼務フラグ</span>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!!selected.isConcurrent}
                  onChange={(e) => setConcurrent(selected.id, e.target.checked)}
                />
                <span>
                  このノードは兼務（主務組織は別にある）
                  <br />
                  <small style={{ color: "var(--text-muted)" }}>
                    ONにすると名前の先頭に「*」が自動で付きます。各メンバーの主務組織は1つ、兼務先は複数あってOK。
                  </small>
                </span>
              </label>
            </label>

            <div className="field">
              <span className="field__label">従業員マスターとの紐付け</span>
              {linkedEmployee ? (
                <div className="emplink__current">
                  <div className="emplink__currentName">
                    {linkedEmployee.full_name || "（氏名なし）"}
                  </div>
                  <div className="emplink__currentMeta">
                    <code>{linkedEmployee.employee_number}</code>
                    {linkedEmployee.department && <> · {linkedEmployee.department}</>}
                    {linkedEmployee.position_title && <> · {linkedEmployee.position_title}</>}
                    {linkedEmployee.employment_type && <> · {linkedEmployee.employment_type}</>}
                  </div>
                  <div className="emplink__actions">
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => setLinkOpen(true)}
                    >
                      別の従業員に変更
                    </button>
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => setEmployeeNumber(selected.id, null)}
                      title="紐付けを解除（ノード自体は残ります）"
                    >
                      解除
                    </button>
                  </div>
                </div>
              ) : selected.employeeNumber ? (
                <div className="emplink__current emplink__current--orphan">
                  <div className="emplink__currentName">
                    社員番号 <code>{selected.employeeNumber}</code>
                  </div>
                  <div className="emplink__currentMeta">
                    従業員マスターに該当者が見つかりません。マスターを更新するか、紐付けを変更してください。
                  </div>
                  <div className="emplink__actions">
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => setLinkOpen(true)}
                    >
                      別の従業員に変更
                    </button>
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => setEmployeeNumber(selected.id, null)}
                    >
                      解除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="emplink__current emplink__current--empty">
                  <div className="emplink__currentMeta">
                    まだ従業員マスターと紐付いていません。
                    {(() => {
                      // Show a one-tap auto-link affordance when the current
                      // chip name uniquely matches an employee. The user
                      // can also open the picker to override / search.
                      const auto = findEmployeeByName(selected.name, employees);
                      if (!auto) return null;
                      return (
                        <>
                          <br />
                          名前一致：<strong>{auto.full_name}</strong>{" "}
                          <code>{auto.employee_number}</code>
                        </>
                      );
                    })()}
                  </div>
                  <div className="emplink__actions">
                    {(() => {
                      const auto = findEmployeeByName(selected.name, employees);
                      if (!auto) return null;
                      return (
                        <button
                          className="btn btn--primary btn--xs"
                          onClick={() =>
                            setEmployeeNumber(selected.id, auto.employee_number, {
                              name: auto.full_name ?? selected.name,
                            })
                          }
                        >
                          名前で自動紐付け
                        </button>
                      );
                    })()}
                    <button
                      className="btn btn--xs"
                      onClick={() => setLinkOpen(true)}
                    >
                      ＋従業員を選択
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="field">
              <span className="field__label">所属</span>
              {affiliations && (
                <div className="affiliations">
                  <div className="affiliations__row">
                    <span className="affiliations__label affiliations__label--primary">主務</span>
                    <span className="affiliations__path">
                      {affiliations.primary
                        ? pathOf(nodes, affiliations.primary, false)
                        : selected.employeeNumber
                          ? "（主務ノード未設定 — どこかで「兼務フラグ」を外してください）"
                          : pathOf(nodes, selected, false)}
                    </span>
                  </div>
                  {affiliations.concurrent.length > 0 && (
                    <div className="affiliations__row affiliations__row--list">
                      <span className="affiliations__label affiliations__label--concurrent">
                        兼務（{affiliations.concurrent.length}件）
                      </span>
                      <ul className="affiliations__list">
                        {affiliations.concurrent.map((c) => (
                          <li key={c.id}>{pathOf(nodes, c, false)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}

        {selected.kind === "department" && (
          <>
            <div className="field">
              <span className="field__label">所属</span>
              <span className="field__value">{pathOf(nodes, selected, true)}</span>
            </div>
            <div className="field">
              <span className="field__label">配下</span>
              <span className="field__value">{descCount}件</span>
            </div>
          </>
        )}

        <button className="btn btn--danger" onClick={() => setConfirmOpen(true)}>
          このノードを削除
        </button>
      </aside>

      {confirmOpen && (
        <DeleteModal
          target={selected}
          descCount={descCount}
          onCancel={() => setConfirmOpen(false)}
          onCascade={() => {
            deleteNode(selected.id, "cascade");
            setConfirmOpen(false);
          }}
          onPromote={() => {
            deleteNode(selected.id, "promoteToRoot");
            setConfirmOpen(false);
          }}
        />
      )}

      {linkOpen && selected.kind === "person" && (
        <EmployeeLinkDialog
          currentEmployeeNumber={selected.employeeNumber ?? null}
          onCancel={() => setLinkOpen(false)}
          onPick={(emp) => {
            setEmployeeNumber(selected.id, emp.employee_number, {
              name: emp.full_name ?? selected.name,
            });
            setLinkOpen(false);
          }}
        />
      )}
    </>
  );
}

function DeleteModal({
  target,
  descCount,
  onCancel,
  onCascade,
  onPromote,
}: {
  target: OrgNode;
  descCount: number;
  onCancel: () => void;
  onCascade: () => void;
  onPromote: () => void;
}) {
  const showThreeWay = target.kind === "department" && descCount > 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">削除の確認</h3>
        {showThreeWay ? (
          <>
            <p className="modal__body">
              <strong>{target.name}</strong> には配下 {descCount} 件があります。どのように処理しますか？
            </p>
            <div className="modal__actions modal__actions--column">
              <button className="btn btn--danger" onClick={onCascade}>
                a) 配下ごとまとめて削除
              </button>
              <button className="btn" onClick={onPromote}>
                b) 子をルートへ移動して、このノードのみ削除
              </button>
              <button className="btn btn--ghost" onClick={onCancel}>
                c) キャンセル
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal__body">
              <strong>{target.name}</strong> を削除します。よろしいですか？
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onCancel}>
                キャンセル
              </button>
              <button className="btn btn--danger" onClick={onCascade}>
                削除する
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
