import { useEffect, useMemo, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * Header-mounted alert: a small ⚠ button with a count badge that appears
 * in OrgSubNav whenever there are person nodes not linked to the employee
 * master. Clicking opens a popover listing the offenders; clicking a name
 * jumps to that node so the Inspector can fix the link. Replaces the old
 * full-width banner that ate vertical space on every screen.
 */
export function UnlinkedAlert() {
  const nodes = useOrgStore((s) => s.nodes);
  const setSelected = useOrgStore((s) => s.setSelected);
  const employees = useEmployeesStore((s) => s.employees);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  // Close when clicking outside or pressing Escape
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (unlinked.length === 0) return null;

  return (
    <div className="hdrAlert" ref={wrapRef}>
      <button
        className={`hdrAlert__btn hdrAlert__btn--warn ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`${unlinked.length}名が従業員マスター未紐付け`}
      >
        <span className="hdrAlert__icon" aria-hidden>⚠</span>
        <span className="hdrAlert__count">{unlinked.length}</span>
      </button>
      {open && (
        <div className="hdrAlert__panel" role="dialog">
          <div className="hdrAlert__head">
            <strong>{unlinked.length}名</strong> が従業員マスター未紐付けです
            <p className="hdrAlert__desc">
              人事発令の差分計算から除外されるため、Inspectorから紐付けてください。
            </p>
          </div>
          <ul className="hdrAlert__list">
            {unlinked.map((p) => (
              <li key={p.id}>
                <button
                  className="hdrAlert__name"
                  onClick={() => {
                    setSelected(p.id);
                    setOpen(false);
                  }}
                >
                  <span>{p.name || "（名前未設定）"}</span>
                  <code className="hdrAlert__num">
                    {p.employeeNumber
                      ? `${p.employeeNumber}（マスターに該当なし）`
                      : "未設定"}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
