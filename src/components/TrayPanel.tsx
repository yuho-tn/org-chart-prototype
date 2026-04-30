import type { DragEvent } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useDndStore } from "../store/useDndStore";
import { setDragKind } from "../lib/dndState";
import type { OrgNode } from "../lib/types";

const PERSON_MIME = "application/x-person-id";
const DEPT_MIME = "application/x-dept-id";

function categoryShort(node: OrgNode): string {
  if (node.kind === "person") {
    if (node.isExecutive) return "役員";
    if (node.roleLabel) return node.roleLabel;
    return "人員";
  }
  return node.category ?? "DEPT";
}

export function TrayPanel() {
  const nodes = useOrgStore((s) => s.nodes);
  const setSelected = useOrgStore((s) => s.setSelected);
  const selectedId = useOrgStore((s) => s.selectedId);
  const deleteNode = useOrgStore((s) => s.deleteNode);

  const tray = nodes.filter((n) => n.isUnplaced);

  function startDrag(e: DragEvent, node: OrgNode) {
    const mime = node.kind === "person" ? PERSON_MIME : DEPT_MIME;
    e.dataTransfer.setData(mime, node.id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("is-being-dragged");
    setDragKind(node.kind === "person" ? "person" : "dept");
    useDndStore.getState().startDrag({
      id: node.id,
      kind: node.kind === "person" ? "person" : "dept",
      label: node.name,
      source: "tray",
    });
  }

  function endDrag(e: DragEvent) {
    e.currentTarget.classList.remove("is-being-dragged");
    setDragKind(null);
    useDndStore.getState().endDrag();
  }

  function onItemClick(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    setSelected(id);
  }

  function onItemDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    deleteNode(id, "cascade");
  }

  return (
    <section className="tray">
      <header className="tray__header">
        <h2 className="sidebar__title" style={{ margin: 0 }}>
          未配置（{tray.length}）
        </h2>
        <span className="tray__hint" title="ここから組織図にドラッグして配置します">
          ⇢ Drag to canvas
        </span>
      </header>

      {tray.length === 0 ? (
        <p className="tray__empty">
          未配置のノードはありません。
          <br />
          上の「＋部署」「＋人員」「＋役員」から追加すると、ここに表示されます。
        </p>
      ) : (
        <ul className="tray__list">
          {tray.map((node) => {
            const isPerson = node.kind === "person";
            const cls = [
              "tray__item",
              isPerson ? "tray__item--person" : "tray__item--dept",
              selectedId === node.id ? "is-selected" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <li key={node.id} className={cls}>
                <div
                  className="tray__handle"
                  draggable
                  onDragStart={(e) => startDrag(e, node)}
                  onDragEnd={endDrag}
                  onClick={(e) => onItemClick(e, node.id)}
                  title="ドラッグして配置先を指定"
                >
                  <span className="tray__kind">{categoryShort(node)}</span>
                  <span className="tray__name">{node.name}</span>
                  <span className="tray__grip" aria-hidden>
                    ⠿
                  </span>
                </div>
                <button
                  className="tray__delete"
                  onClick={(e) => onItemDelete(e, node.id)}
                  title="削除"
                  aria-label="削除"
                >
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
