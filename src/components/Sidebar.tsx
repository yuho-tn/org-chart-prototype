import { useReactFlow } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";

export function Sidebar() {
  const selectedId = useOrgStore((s) => s.selectedId);
  const nodes = useOrgStore((s) => s.nodes);
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);
  const rf = useReactFlow();

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const parentForAdd = selected?.kind === "department" ? selected.id : selected?.parentId ?? null;
  const parentLabel = parentForAdd
    ? nodes.find((n) => n.id === parentForAdd)?.name ?? "ルート"
    : "ルート";

  return (
    <aside className="sidebar">
      <h2 className="sidebar__title">ツール</h2>
      <p className="sidebar__hint">
        追加先：<strong>{parentLabel}</strong>
        <br />
        <span className="sidebar__hintSub">
          （部署選択中はその直下に、人員選択中は同じ親に追加）
        </span>
      </p>
      <button className="btn btn--primary" onClick={() => addDepartment(parentForAdd)}>
        ＋部署を追加
      </button>
      <button className="btn" onClick={() => addPerson(parentForAdd)}>
        ＋人員を追加
      </button>

      <h2 className="sidebar__title sidebar__title--mt">レイアウト</h2>
      <button className="btn btn--ghost" onClick={() => rf.fitView({ padding: 0.2, duration: 200 })}>
        フィットビュー
      </button>
    </aside>
  );
}
