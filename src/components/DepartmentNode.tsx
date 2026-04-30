import { useState, type DragEvent, type KeyboardEvent } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { useDndStore } from "../store/useDndStore";
import { colorAt, ROOT_COLOR, EXE_COLOR } from "../lib/palette";
import { setDragKind } from "../lib/dndState";
import type { DeptCategory, PersonRole } from "../lib/types";

export type DeptNodeData = {
  name: string;
  category: DeptCategory;
  colorIndex: number;
  selected: boolean;
  isBeingDragged: boolean;
  dropState: "none" | "valid" | "invalid";
  leaders: {
    id: string;
    name: string;
    roleLabel: PersonRole;
    selected: boolean;
    isExecutive: boolean;
  }[];
  members: { id: string; name: string; selected: boolean }[];
};

const PERSON_MIME = "application/x-person-id";
const DEPT_MIME = "application/x-dept-id";

function categoryLabel(cat: DeptCategory): string {
  switch (cat) {
    case "ROOT":
      return "ORG";
    case "Exe":
      return "EXE";
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
  const rename = useOrgStore((s) => s.rename);
  const setToast = useOrgStore((s) => s.setToast);

  const [editingChipId, setEditingChipId] = useState<string | null>(null);
  const [editingDeptName, setEditingDeptName] = useState(false);
  const [draft, setDraft] = useState("");

  const isRoot = data.category === "ROOT";
  const isExe = data.category === "Exe";
  const color = isRoot ? ROOT_COLOR : isExe ? EXE_COLOR : colorAt(data.colorIndex);

  const cls = [
    "dept-card",
    `dept-card--${data.category.toLowerCase()}`,
    data.selected ? "is-selected" : "",
    data.isBeingDragged ? "is-being-dragged" : "",
    data.dropState === "valid" ? "is-drop-valid" : "",
    data.dropState === "invalid" ? "is-drop-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleDragOver(e: DragEvent) {
    const types = e.dataTransfer.types;
    if (types.includes(PERSON_MIME) || types.includes(DEPT_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      e.currentTarget.classList.add("is-chip-drop-over");
      useDndStore.getState().setHover(data.name, "valid");
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.currentTarget.classList.remove("is-chip-drop-over");
    useDndStore.getState().setHover(null);
  }

  function handleDrop(e: DragEvent) {
    e.currentTarget.classList.remove("is-chip-drop-over");
    const personId = e.dataTransfer.getData(PERSON_MIME);
    const deptId = e.dataTransfer.getData(DEPT_MIME);
    const draggedId = personId || deptId;
    if (!draggedId) return;
    e.preventDefault();
    e.stopPropagation();
    const result = reparent(draggedId, id);
    if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
      setToast({ kind: "error", message: result.reason });
    }
  }

  function startChipDrag(e: DragEvent, personId: string, personName: string) {
    e.dataTransfer.setData(PERSON_MIME, personId);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("is-being-dragged");
    setDragKind("person");
    useDndStore.getState().startDrag({
      id: personId,
      kind: "person",
      label: personName,
      source: "tree",
    });
  }

  function endChipDrag(e: DragEvent) {
    e.currentTarget.classList.remove("is-being-dragged");
    setDragKind(null);
    useDndStore.getState().endDrag();
  }

  function selectChip(e: React.MouseEvent, personId: string) {
    e.stopPropagation();
    setSelected(personId);
  }

  function startChipEdit(e: React.MouseEvent, personId: string, current: string) {
    e.stopPropagation();
    setEditingChipId(personId);
    setDraft(current);
  }

  function commitChipEdit() {
    if (editingChipId && draft.trim() && draft.trim() !== "") {
      rename(editingChipId, draft.trim());
    }
    setEditingChipId(null);
  }

  function cancelChipEdit() {
    setEditingChipId(null);
  }

  function startDeptNameEdit(e: React.MouseEvent) {
    if (data.category === "ROOT") return;
    e.stopPropagation();
    setEditingDeptName(true);
    setDraft(data.name);
  }

  function commitDeptNameEdit() {
    if (draft.trim() && draft.trim() !== data.name) {
      rename(id, draft.trim());
    }
    setEditingDeptName(false);
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitChipEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelChipEdit();
    }
  }

  function onDeptNameKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitDeptNameEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingDeptName(false);
    }
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
        {editingDeptName ? (
          <input
            className="nodrag dept-card__nameInput"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDeptNameEdit}
            onKeyDown={onDeptNameKeyDown}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="dept-card__name"
            onDoubleClick={startDeptNameEdit}
            title={data.category === "ROOT" ? data.name : `${data.name}（ダブルクリックで編集）`}
          >
            {data.name}
          </span>
        )}
      </div>
      <div className="dept-card__body">
        {data.leaders.map((p) => {
          if (editingChipId === p.id) {
            return (
              <input
                key={p.id}
                className="nodrag chip chip--editing"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitChipEdit}
                onKeyDown={onChipKeyDown}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            );
          }
          return (
            <div
              key={p.id}
              className={`chip chip--leader nodrag ${p.selected ? "is-selected" : ""} ${p.isExecutive ? "chip--exec" : ""}`}
              style={{ background: color.leaderStrip, color: color.leaderText }}
              draggable
              onDragStart={(e) => startChipDrag(e, p.id, p.name)}
              onDragEnd={endChipDrag}
              onClick={(e) => selectChip(e, p.id)}
              onDoubleClick={(e) => startChipEdit(e, p.id, p.name)}
              onMouseDown={(e) => e.stopPropagation()}
              title={`${p.roleLabel ?? ""}：${p.name}${p.isExecutive ? "（役員）" : ""}（ダブルクリックで編集）`}
            >
              <span className="chip__role">{p.roleLabel}</span>
              <span className="chip__name">{p.name}</span>
              {p.isExecutive && <span className="chip__badge">役員</span>}
            </div>
          );
        })}
        {data.members.length > 0 && data.leaders.length > 0 && (
          <div className="dept-card__divider" />
        )}
        {data.members.map((p) => {
          if (editingChipId === p.id) {
            return (
              <input
                key={p.id}
                className="nodrag chip chip--editing"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitChipEdit}
                onKeyDown={onChipKeyDown}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              />
            );
          }
          return (
            <div
              key={p.id}
              className={`chip chip--member nodrag ${p.selected ? "is-selected" : ""}`}
              draggable
              onDragStart={(e) => startChipDrag(e, p.id, p.name)}
              onDragEnd={endChipDrag}
              onClick={(e) => selectChip(e, p.id)}
              onDoubleClick={(e) => startChipEdit(e, p.id, p.name)}
              onMouseDown={(e) => e.stopPropagation()}
              title={`${p.name}（ダブルクリックで編集）`}
            >
              <span className="chip__bullet">•</span>
              <span className="chip__name">{p.name}</span>
            </div>
          );
        })}
        {data.leaders.length === 0 && data.members.length === 0 && (
          <div className="dept-card__empty">メンバーなし</div>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
