import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { useDndStore } from "../store/useDndStore";
import { colorAt, ROOT_COLOR, EXE_COLOR } from "../lib/palette";
import { setDragKind } from "../lib/dndState";
import { validateMove } from "../lib/move";
import type { DeptCategory, PersonRole } from "../lib/types";

export type DeptNodeData = {
  name: string;
  category: DeptCategory;
  colorIndex: number;
  selected: boolean;
  isBeingDragged: boolean;
  dropState: "none" | "valid" | "invalid";
  /** During dept-on-dept drag, indicates how the hover would resolve. */
  dropIntent: "before" | "after" | "child" | "invalid" | null;
  leaders: {
    id: string;
    name: string;
    roleLabel: PersonRole;
    selected: boolean;
    isExecutive: boolean;
    isConcurrent?: boolean;
    /** True if this person isn't linked to a row in the employee master.
     *  Surfaced as a small ⚠ badge so the user can fix it before generating
     *  an HR announcement (which silently skips unlinked people). */
    isUnlinked?: boolean;
  }[];
  members: {
    id: string;
    name: string;
    selected: boolean;
    isConcurrent?: boolean;
    isUnlinked?: boolean;
  }[];
  viewOnly?: boolean;
};

/** Prefix the chip name with "*" when this is a 兼務 entry. The asterisk
 * is the existing manual convention — toggling Inspector → 兼務 just makes
 * the prefix automatic so it never gets out of sync with intent. */
function displayName(name: string, isConcurrent?: boolean): string {
  if (!isConcurrent) return name;
  return name.startsWith("*") ? name : `*${name}`;
}

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
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const rename = useOrgStore((s) => s.rename);
  const setToast = useOrgStore((s) => s.setToast);
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);

  const [editingChipId, setEditingChipId] = useState<string | null>(null);
  const [editingDeptName, setEditingDeptName] = useState(false);
  const [draft, setDraft] = useState("");
  // IME 変換中は Enter / Blur の commit を抑止する。日本語入力で
  // 確定の Enter が発火する瞬間に commit が走ると、確定済みテキストが
  // ブラウザ側で再挿入されて「二重に入る」ように見えるバグを防ぐ。
  const composingRef = useRef(false);

  const isRoot = data.category === "ROOT";
  const isExe = data.category === "Exe";
  const color = isRoot ? ROOT_COLOR : isExe ? EXE_COLOR : colorAt(data.colorIndex);

  const cls = [
    "dept-card",
    `dept-card--${data.category.toLowerCase()}`,
    data.selected ? "is-selected" : "",
    data.isBeingDragged ? "is-being-dragged" : "",
    data.dropIntent === "before" ? "is-drop-before" : "",
    data.dropIntent === "after" ? "is-drop-after" : "",
    data.dropIntent === "child" ? "is-drop-child" : "",
    data.dropIntent === "invalid" || data.dropState === "invalid"
      ? "is-drop-invalid"
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  function handleDragOver(e: DragEvent) {
    if (data.viewOnly) return;
    const types = e.dataTransfer.types;
    const isPerson = types.includes(PERSON_MIME);
    const isDept = types.includes(DEPT_MIME);
    if (!isPerson && !isDept) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    e.currentTarget.classList.add("is-chip-drop-over");
    e.currentTarget.classList.toggle("is-copy-target", e.altKey);

    const dragging = useDndStore.getState().dragging;
    if (!dragging) return;
    const baseNodes = useOrgStore.getState().nodes;

    if (isDept) {
      // Drop intent: left/right edge → sibling, middle → child.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const w = rect.width;
      let intent: "child" | "before" | "after";
      if (localX < w * 0.25) intent = "before";
      else if (localX > w * 0.75) intent = "after";
      else intent = "child";

      const targetMeta = baseNodes.find((n) => n.id === id);
      let targetParentId: string | null;
      let atIndex: number;
      if (intent === "child") {
        targetParentId = id;
        atIndex = Number.MAX_SAFE_INTEGER;
      } else {
        targetParentId = targetMeta?.parentId ?? null;
        const sibs = baseNodes.filter(
          (n) =>
            n.kind === "department" &&
            n.parentId === targetParentId &&
            !n.isUnplaced &&
            n.id !== dragging.id,
        );
        const idx = sibs.findIndex((s) => s.id === id);
        atIndex = intent === "before" ? Math.max(0, idx) : idx + 1;
      }

      const reason = validateMove(baseNodes, dragging.id, targetParentId);
      if (reason) {
        useDndStore.getState().setHover(data.name, "invalid");
        useDndStore.getState().setPreview(null);
        return;
      }
      const labelSuffix =
        intent === "child" ? "（配下に）" : intent === "before" ? "（左隣に）" : "（右隣に）";
      useDndStore.getState().setHover(`${data.name}${labelSuffix}`, "valid");
      useDndStore
        .getState()
        .setPreview({ sourceId: dragging.id, targetParentId, atIndex });
      return;
    }

    if (isPerson) {
      // Detect insertion position relative to existing chips inside this card.
      const body = (e.currentTarget as HTMLElement).querySelector(
        ".dept-card__body",
      ) as HTMLElement | null;
      let chipIdx = 0;
      if (body) {
        const chips = Array.from(
          body.querySelectorAll<HTMLElement>(
            ".chip:not(.chip--editing)",
          ),
        );
        chipIdx = chips.length;
        for (let i = 0; i < chips.length; i++) {
          const r = chips[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            chipIdx = i;
            break;
          }
        }
      }
      const reason = validateMove(baseNodes, dragging.id, id);
      if (reason) {
        useDndStore.getState().setHover(data.name, "invalid");
        useDndStore.getState().setPreview(null);
        return;
      }
      const total = (data.leaders?.length ?? 0) + (data.members?.length ?? 0);
      const slot =
        total === 0
          ? "（最初のメンバーとして）"
          : chipIdx === 0
            ? "（最上部に）"
            : chipIdx >= total
              ? "（末尾に）"
              : `（${chipIdx + 1}番目に）`;
      useDndStore.getState().setHover(`${data.name}${slot}`, "valid");
      useDndStore
        .getState()
        .setPreview({ sourceId: dragging.id, targetParentId: id, atIndex: chipIdx });
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.currentTarget.classList.remove("is-chip-drop-over");
    // Intentionally do not clear preview here — moving onto another card
    // will overwrite it. Clearing causes layout flicker between cards.
  }

  function handleDrop(e: DragEvent) {
    if (data.viewOnly) return;
    e.currentTarget.classList.remove("is-chip-drop-over");
    e.currentTarget.classList.remove("is-copy-target");
    e.preventDefault();
    e.stopPropagation();
    const preview = useDndStore.getState().preview;
    if (!preview) return;
    const isCopy = e.altKey;
    const result = isCopy
      ? duplicateAtPosition(
          preview.sourceId,
          preview.targetParentId,
          preview.atIndex,
        )
      : reparent(preview.sourceId, preview.targetParentId, preview.atIndex);
    useDndStore.getState().endDrag();
    if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
      setToast({ kind: "error", message: result.reason });
    }
  }

  function startChipDrag(e: DragEvent, personId: string, personName: string) {
    if (data.viewOnly) {
      e.preventDefault();
      return;
    }
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
    if (data.viewOnly) return;
    e.stopPropagation();
    setEditingChipId(personId);
    setDraft(current);
  }

  function commitChipEdit() {
    if (composingRef.current) return;
    if (editingChipId && draft.trim() && draft.trim() !== "") {
      rename(editingChipId, draft.trim());
    }
    setEditingChipId(null);
  }

  function cancelChipEdit() {
    setEditingChipId(null);
  }

  function startDeptNameEdit(e: React.MouseEvent) {
    if (data.viewOnly) return;
    if (data.category === "ROOT") return;
    e.stopPropagation();
    setEditingDeptName(true);
    setDraft(data.name);
  }

  function commitDeptNameEdit() {
    if (composingRef.current) return;
    if (draft.trim() && draft.trim() !== data.name) {
      rename(id, draft.trim());
    }
    setEditingDeptName(false);
  }

  function onChipKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
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
    if ((e.nativeEvent as { isComposing?: boolean }).isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commitDeptNameEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingDeptName(false);
    }
  }

  function onComposeStart() {
    composingRef.current = true;
  }

  function onComposeEnd(e: React.CompositionEvent<HTMLInputElement>) {
    composingRef.current = false;
    setDraft((e.target as HTMLInputElement).value);
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
            onCompositionStart={onComposeStart}
            onCompositionEnd={onComposeEnd}
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
                onCompositionStart={onComposeStart}
                onCompositionEnd={onComposeEnd}
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
              className={`chip chip--leader nodrag ${p.selected ? "is-selected" : ""} ${p.isExecutive ? "chip--exec" : ""} ${p.isUnlinked ? "chip--unlinked" : ""}`}
              style={{ background: color.leaderStrip, color: color.leaderText }}
              draggable={!data.viewOnly}
              onDragStart={(e) => startChipDrag(e, p.id, p.name)}
              onDragEnd={endChipDrag}
              onClick={(e) => selectChip(e, p.id)}
              onDoubleClick={(e) => startChipEdit(e, p.id, p.name)}
              onMouseDown={(e) => e.stopPropagation()}
              title={`${p.roleLabel ?? ""}：${p.name}${p.isExecutive ? "（役員）" : ""}${p.isConcurrent ? "（兼務）" : ""}${p.isUnlinked ? "（従業員マスター未紐付け）" : ""}（ダブルクリックで編集）`}
            >
              <span className="chip__role">{p.roleLabel}</span>
              <span className="chip__name">{displayName(p.name, p.isConcurrent)}</span>
              {p.isUnlinked && (
                <span
                  className="chip__warn"
                  aria-label="従業員マスター未紐付け"
                  title="従業員マスターと紐付いていません — Inspectorから紐付けてください"
                >
                  ⚠
                </span>
              )}
              {p.isExecutive && <span className="chip__badge">役員</span>}
              {p.isConcurrent && <span className="chip__badge chip__badge--concurrent">兼務</span>}
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
                onCompositionStart={onComposeStart}
                onCompositionEnd={onComposeEnd}
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
              className={`chip chip--member nodrag ${p.selected ? "is-selected" : ""} ${p.isUnlinked ? "chip--unlinked" : ""}`}
              draggable={!data.viewOnly}
              onDragStart={(e) => startChipDrag(e, p.id, p.name)}
              onDragEnd={endChipDrag}
              onClick={(e) => selectChip(e, p.id)}
              onDoubleClick={(e) => startChipEdit(e, p.id, p.name)}
              onMouseDown={(e) => e.stopPropagation()}
              title={`${p.name}${p.isConcurrent ? "（兼務）" : ""}${p.isUnlinked ? "（従業員マスター未紐付け）" : ""}（ダブルクリックで編集）`}
            >
              <span className="chip__bullet">•</span>
              <span className="chip__name">{displayName(p.name, p.isConcurrent)}</span>
              {p.isUnlinked && (
                <span
                  className="chip__warn"
                  aria-label="従業員マスター未紐付け"
                  title="従業員マスターと紐付いていません — Inspectorから紐付けてください"
                >
                  ⚠
                </span>
              )}
              {p.isConcurrent && <span className="chip__badge chip__badge--concurrent">兼務</span>}
            </div>
          );
        })}
        {data.leaders.length === 0 && data.members.length === 0 && data.viewOnly && (
          <div className="dept-card__empty">メンバーなし</div>
        )}
        {!data.viewOnly && (
          <button
            className="nodrag dept-card__add-member"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              addPerson(id, { placed: true });
            }}
            onMouseDown={(e) => e.stopPropagation()}
            title="この部署に人員を追加"
          >
            ＋ 人員を追加
          </button>
        )}
      </div>
      <Handle type="source" position={Position.Bottom} />
      {!data.viewOnly && (
        <button
          className="nodrag dept-card__add-child"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            addDepartment(id, { placed: true });
          }}
          onMouseDown={(e) => e.stopPropagation()}
          title="この部署の配下に子部署を追加"
          style={{ borderColor: color.border, color: color.border }}
        >
          ＋
        </button>
      )}
    </div>
  );
}
