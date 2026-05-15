import type { DragEvent } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { useDndStore } from "../store/useDndStore";
import { setDragKind } from "../lib/dndState";
import type { PersonRole } from "../lib/types";

export type ExecNodeData = {
  name: string;
  role: PersonRole;
  /** Optional 兼任 role rendered inline as "ROLE 兼 SECONDARY". */
  secondaryRole?: PersonRole;
  selected: boolean;
  isConcurrent?: boolean;
  /** True if this person isn't linked to a row in the employee master. */
  isUnlinked?: boolean;
};

const PERSON_MIME = "application/x-person-id";

export function ExecutiveNode({ id, data }: NodeProps<ExecNodeData>) {
  const setSelected = useOrgStore((s) => s.setSelected);

  function startDrag(e: DragEvent) {
    e.dataTransfer.setData(PERSON_MIME, id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("is-being-dragged");
    setDragKind("person");
    useDndStore.getState().startDrag({
      id,
      kind: "person",
      label: data.name,
      source: "tree",
    });
  }

  function endDrag(e: DragEvent) {
    e.currentTarget.classList.remove("is-being-dragged");
    setDragKind(null);
    useDndStore.getState().endDrag();
  }

  function selectClick(e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(id);
  }

  return (
    <div
      className={`exec-card nodrag ${data.selected ? "is-selected" : ""} ${data.isUnlinked ? "exec-card--unlinked" : ""}`}
      draggable
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={selectClick}
      title={`${data.role}${data.secondaryRole ? ` 兼 ${data.secondaryRole}` : ""}：${data.name}${data.isConcurrent ? "（兼務）" : ""}${data.isUnlinked ? "（従業員マスター未紐付け）" : ""}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <span className="exec-card__role">
        {data.role}
        {data.secondaryRole && (
          <>
            <span className="exec-card__roleSep"> 兼 </span>
            {data.secondaryRole}
          </>
        )}
      </span>
      <span className="exec-card__name">
        {data.isConcurrent && !data.name.startsWith("*") ? `*${data.name}` : data.name}
      </span>
      {data.isUnlinked && (
        <span
          className="chip__warn"
          aria-label="従業員マスター未紐付け"
          title="従業員マスターと紐付いていません"
        >
          ⚠
        </span>
      )}
      {data.isConcurrent && <span className="chip__badge chip__badge--concurrent">兼務</span>}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
