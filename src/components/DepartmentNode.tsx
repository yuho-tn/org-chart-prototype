import type { DragEvent } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { colorAt, ROOT_COLOR } from "../lib/palette";
import type { DeptCategory, PersonRole } from "../lib/types";

export type DeptNodeData = {
  name: string;
  category: DeptCategory;
  colorIndex: number;
  selected: boolean;
  dropState: "none" | "valid" | "invalid";
  leaders: { id: string; name: string; roleLabel: PersonRole; selected: boolean }[];
  members: { id: string; name: string; selected: boolean }[];
};

const PERSON_MIME = "application/x-person-id";

function categoryLabel(cat: DeptCategory): string {
  switch (cat) {
    case "ROOT":
      return "ORG";
    case "DIV":
      return "DIV";
    case "TM":
      return "TM";
    case "Unit":
      return "UNIT";
    default:
      return "DEPT";
  }
}

export function DepartmentNode({ id, data }: NodeProps<DeptNodeData>) {
  const setSelected = useOrgStore((s) => s.setSelected);
  const reparent = useOrgStore((s) => s.reparent);
  const setToast = useOrgStore((s) => s.setToast);

  const isRoot = data.category === "ROOT";
  const color = isRoot ? ROOT_COLOR : colorAt(data.colorIndex);

  const cls = [
    "dept-card",
    `dept-card--${data.category.toLowerCase()}`,
    data.selected ? "is-selected" : "",
    data.dropState === "valid" ? "is-drop-valid" : "",
    data.dropState === "invalid" ? "is-drop-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleDragOver(e: DragEvent) {
    if (e.dataTransfer.types.includes(PERSON_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("is-chip-drop-over");
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.currentTarget.classList.remove("is-chip-drop-over");
  }

  function handleDrop(e: DragEvent) {
    e.currentTarget.classList.remove("is-chip-drop-over");
    const personId = e.dataTransfer.getData(PERSON_MIME);
    if (!personId) return;
    e.preventDefault();
    const result = reparent(personId, id);
    if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
      setToast({ kind: "error", message: result.reason });
    }
  }

  function startChipDrag(e: DragEvent, personId: string) {
    e.dataTransfer.setData(PERSON_MIME, personId);
    e.dataTransfer.effectAllowed = "move";
  }

  function selectChip(e: React.MouseEvent, personId: string) {
    e.stopPropagation();
    setSelected(personId);
  }

  return (
    <div
      className={cls}
      style={{ borderColor: color.border, background: color.body }}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Handle type="target" position={Position.Top} />
      <div
        className="dept-card__header"
        style={{ background: color.header, color: color.headerText }}
      >
        <span className="dept-card__category">{categoryLabel(data.category)}</span>
        <span className="dept-card__name">{data.name}</span>
      </div>
      <div className="dept-card__body">
        {data.leaders.map((p) => (
          <div
            key={p.id}
            className={`chip chip--leader nodrag ${p.selected ? "is-selected" : ""}`}
            style={{ background: color.leaderStrip, color: color.leaderText }}
            draggable
            onDragStart={(e) => startChipDrag(e, p.id)}
            onClick={(e) => selectChip(e, p.id)}
            onMouseDown={(e) => e.stopPropagation()}
            title={`${p.roleLabel ?? ""}：${p.name}`}
          >
            <span className="chip__role">{p.roleLabel}</span>
            <span className="chip__name">{p.name}</span>
          </div>
        ))}
        {data.members.length > 0 && data.leaders.length > 0 && (
          <div className="dept-card__divider" />
        )}
        {data.members.map((p) => (
          <div
            key={p.id}
            className={`chip chip--member nodrag ${p.selected ? "is-selected" : ""}`}
            draggable
            onDragStart={(e) => startChipDrag(e, p.id)}
            onClick={(e) => selectChip(e, p.id)}
            onMouseDown={(e) => e.stopPropagation()}
            title={p.name}
          >
            <span className="chip__bullet">•</span>
            <span className="chip__name">{p.name}</span>
          </div>
        ))}
        {data.leaders.length === 0 && data.members.length === 0 && (
          <div className="dept-card__empty">メンバーなし</div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
