import { useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * Banner shown above the canvas when one or more person nodes aren't
 * linked to a row in the employee master. Unlinked nodes are silently
 * dropped from the HR-announcement diff (computeAnnouncement requires
 * employee_number to do its hires/leaves/move detection), so flagging
 * them prominently keeps the user from generating a misleading 発令.
 *
 * Click anywhere on the banner to expand a list of names; click a name
 * to jump to that node in the canvas (we set the selection so the
 * Inspector pops open with the link controls visible).
 */
export function UnlinkedAlert() {
  const nodes = useOrgStore((s) => s.nodes);
  const setSelected = useOrgStore((s) => s.setSelected);
  const employees = useEmployeesStore((s) => s.employees);
  const [expanded, setExpanded] = useState(false);

  const unlinked = useMemo(() => {
    if (!isSupabaseConfigured) return [];
    const valid = new Set(employees.map((e) => e.employee_number));
    return nodes.filter(
      (n) =>
        n.kind === "person" &&
        !n.isUnplaced &&
        (!n.employeeNumber || !valid.has(n.employeeNumber)),
    );
  }, [nodes, employees]);

  if (unlinked.length === 0) return null;

  return (
    <div className={`unlinked-alert ${expanded ? "is-expanded" : ""}`}>
      <button
        className="unlinked-alert__bar"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="unlinked-alert__icon" aria-hidden>⚠</span>
        <span className="unlinked-alert__text">
          <strong>{unlinked.length} 名</strong> が従業員マスターと未紐付けです
          {" "}— 人事発令の差分計算から除外されるため、Inspectorから紐付けてください。
        </span>
        <span className="unlinked-alert__caret" aria-hidden>{expanded ? "▴" : "▾"}</span>
      </button>
      {expanded && (
        <ul className="unlinked-alert__list">
          {unlinked.map((p) => (
            <li key={p.id}>
              <button
                className="unlinked-alert__name"
                onClick={() => setSelected(p.id)}
                title="この人員を選択（Inspectorで紐付け）"
              >
                {p.name || "（名前未設定）"}
                {p.employeeNumber ? (
                  <code className="unlinked-alert__num">{p.employeeNumber}（マスターに該当なし）</code>
                ) : (
                  <code className="unlinked-alert__num">未設定</code>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
