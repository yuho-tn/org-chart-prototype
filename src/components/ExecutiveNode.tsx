import type { DragEvent } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import type { PersonRole } from "../lib/types";

export type ExecNodeData = {
  name: string;
  role: PersonRole;
  selected: boolean;
};

const PERSON_MIME = "application/x-person-id";

export function ExecutiveNode({ id, data }: NodeProps<ExecNodeData>) {
  const setSelected = useOrgStore((s) => s.setSelected);

  function startDrag(e: DragEvent) {
    e.dataTransfer.setData(PERSON_MIME, id);
    e.dataTransfer.effectAllowed = "move";
  }

  function selectClick(e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(id);
  }

  return (
    <div
      className={`exec-card nodrag ${data.selected ? "is-selected" : ""}`}
      draggable
      onDragStart={startDrag}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={selectClick}
      title={`${data.role}：${data.name}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <span className="exec-card__role">{data.role}</span>
      <span className="exec-card__name">{data.name}</span>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
