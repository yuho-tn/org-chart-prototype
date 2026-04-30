import { useReactFlow } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { VersionsPanel } from "./VersionsPanel";

export function Sidebar() {
  const selectedId = useOrgStore((s) => s.selectedId);
  const nodes = useOrgStore((s) => s.nodes);
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);
  const setToast = useOrgStore((s) => s.setToast);
  const rf = useReactFlow();

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  let deptForPerson: string | null = null;
  let parentForDept: string | null = null;
  if (selected) {
    if (selected.kind === "department") {
      deptForPerson = selected.id;
      parentForDept = selected.id;
    } else {
      deptForPerson = selected.parentId;
      parentForDept = selected.parentId;
    }
  }

  const targetDept = deptForPerson ? nodes.find((n) => n.id === deptForPerson) : null;

  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <h2 className="sidebar__title">追加</h2>
        <div className="sidebar__hint">
          追加先：<strong>{targetDept?.name ?? "（ルート）"}</strong>
          <div className="sidebar__hintSub">
            部署選択中はその直下、人員選択中は同じ部署内に追加されます
          </div>
        </div>
        <div className="sidebar__btnRow">
          <button
            className="btn btn--primary"
            onClick={() => addDepartment(parentForDept)}
            title={parentForDept ? "選択中の配下に部署を追加" : "ルートに部署を追加"}
          >
            ＋部署
          </button>
          <button
            className="btn"
            onClick={() => {
              if (!deptForPerson) {
                setToast({
                  kind: "error",
                  message: "人員を追加するには、先に部署を選択してください",
                });
                return;
              }
              addPerson(deptForPerson);
            }}
            disabled={!deptForPerson}
            title={deptForPerson ? "この部署にメンバーを追加" : "部署を選択してください"}
          >
            ＋人員
          </button>
        </div>
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => rf.fitView({ padding: 0.2, duration: 200 })}
        >
          フィットビュー
        </button>
      </section>

      <VersionsPanel />
    </aside>
  );
}
