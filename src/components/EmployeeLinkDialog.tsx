import { useEffect, useMemo, useState } from "react";
import { useEmployeesStore } from "../store/useEmployeesStore";
import type { EmployeeRow } from "../lib/supabase";

/**
 * Modal that lets the user pick an employee from the master to link to a
 * person node. Linking is what powers the "未配置メンバー" panel and the
 * 兼務 / 主務 affiliation summary in the Inspector.
 */
export function EmployeeLinkDialog({
  currentEmployeeNumber,
  onPick,
  onCancel,
}: {
  currentEmployeeNumber: string | null;
  onPick: (employee: EmployeeRow) => void;
  onCancel: () => void;
}) {
  const employees = useEmployeesStore((s) => s.employees);
  const refresh = useEmployeesStore((s) => s.refresh);
  const loading = useEmployeesStore((s) => s.loading);

  const [query, setQuery] = useState("");

  useEffect(() => {
    if (employees.length === 0) refresh();
  }, [employees.length, refresh]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = employees.filter((e) => !e.left_at);
    if (!q) return active.slice(0, 200);
    return active
      .filter((e) => {
        return (
          e.full_name?.toLowerCase().includes(q) ||
          e.employee_number.toLowerCase().includes(q) ||
          e.department?.toLowerCase().includes(q) ||
          e.position_title?.toLowerCase().includes(q)
        );
      })
      .slice(0, 200);
  }, [employees, query]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, width: "92vw" }}
      >
        <h3 className="modal__title">従業員マスターから紐付け</h3>
        <p className="modal__body" style={{ margin: "0 0 10px" }}>
          このノードに紐付ける従業員を従業員マスターから選んでください。
          兼務の場合は同じ従業員を別ノードに紐付けることもできます。
        </p>

        <input
          className="field__input"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="氏名 / 社員番号 / 部署 で検索"
        />

        <div className="emplink__list">
          {loading && employees.length === 0 ? (
            <p className="versions__empty">読み込み中…</p>
          ) : filtered.length === 0 ? (
            <p className="versions__empty">
              {query.trim() ? "該当する従業員がいません" : "従業員マスターに登録がありません"}
            </p>
          ) : (
            filtered.map((e) => {
              const isCurrent = e.employee_number === currentEmployeeNumber;
              return (
                <button
                  key={e.employee_number}
                  className={`emplink__row ${isCurrent ? "is-current" : ""}`}
                  onClick={() => onPick(e)}
                >
                  <span className="emplink__name">
                    {e.full_name || "（氏名なし）"}
                    {isCurrent && <span className="emplink__currentBadge">現在の紐付け</span>}
                  </span>
                  <span className="emplink__meta">
                    <code>{e.employee_number}</code>
                    {e.department && <span>· {e.department}</span>}
                    {e.position_title && <span>· {e.position_title}</span>}
                    {e.employment_type && <span>· {e.employment_type}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="modal__actions" style={{ marginTop: 14 }}>
          <button className="btn btn--ghost" onClick={onCancel}>
            キャンセル
          </button>
        </div>
      </div>
    </div>
  );
}
