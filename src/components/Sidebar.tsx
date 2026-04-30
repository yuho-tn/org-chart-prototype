import { useReactFlow } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";

export function Sidebar() {
  const selectedId = useOrgStore((s) => s.selectedId);
  const nodes = useOrgStore((s) => s.nodes);
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);
  const setToast = useOrgStore((s) => s.setToast);
  const rf = useReactFlow();

  const selected = nodes.find((n) => n.id === selectedId) ?? null;

  // Determine the department to add into, and the parent for sub-depts.
  let deptForPerson: string | null = null;
  let parentForDept: string | null = null;
  if (selected) {
    if (selected.kind === "department") {
      deptForPerson = selected.id;
      parentForDept = selected.id;
    } else {
      // person selected: add to that person's department, sub-dept under same dept
      deptForPerson = selected.parentId;
      parentForDept = selected.parentId;
    }
  }

  const targetDept = deptForPerson ? nodes.find((n) => n.id === deptForPerson) : null;

  return (
    <aside className="sidebar">
      <h2 className="sidebar__title">追加</h2>
      <div className="sidebar__hint">
        追加先：<strong>{targetDept?.name ?? "（ルート）"}</strong>
        <div className="sidebar__hintSub">
          部署選択中はその直下、人員選択中は同じ部署内に追加されます
        </div>
      </div>
      <button
        className="btn btn--primary"
        onClick={() => addDepartment(parentForDept)}
        title={parentForDept ? "選択中の配下に部署を追加" : "ルートに部署を追加"}
      >
        ＋部署を追加
      </button>
      <button
        className="btn"
        onClick={() => {
          if (!deptForPerson) {
            setToast({ kind: "error", message: "人員を追加するには、先に部署を選択してください" });
            return;
          }
          addPerson(deptForPerson);
        }}
        disabled={!deptForPerson}
        title={deptForPerson ? "この部署にメンバーを追加" : "部署を選択してください"}
      >
        ＋人員を追加
      </button>

      <h2 className="sidebar__title sidebar__title--mt">レイアウト</h2>
      <button className="btn btn--ghost" onClick={() => rf.fitView({ padding: 0.2, duration: 200 })}>
        フィットビュー
      </button>

      <h2 className="sidebar__title sidebar__title--mt">ヒント</h2>
      <ul className="sidebar__tips">
        <li>部署カードはドラッグで親子関係を変更</li>
        <li>人員チップはドラッグで他部署へ移動</li>
        <li>循環する移動は自動でブロック</li>
        <li>未保存時はバッジが「編集中」</li>
      </ul>
    </aside>
  );
}
