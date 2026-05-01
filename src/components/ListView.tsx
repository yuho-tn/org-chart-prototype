import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { useDndStore } from "../store/useDndStore";
import { validateMove } from "../lib/move";
import { setDragKind } from "../lib/dndState";
import { colorAt, ROOT_COLOR, EXE_COLOR } from "../lib/palette";
import type { OrgNode } from "../lib/types";

const PERSON_MIME = "application/x-person-id";
const DEPT_MIME = "application/x-dept-id";

type Tree = {
  node: OrgNode;
  leaders: OrgNode[];
  members: OrgNode[];
  children: Tree[];
  totalMembers: number;
};

function buildTree(nodes: OrgNode[]): Tree[] {
  const allById = new Map(nodes.map((n) => [n.id, n]));
  const isInTray = (n: OrgNode): boolean => {
    let cur: OrgNode | undefined = n;
    while (cur) {
      if (cur.isUnplaced) return true;
      cur = cur.parentId ? allById.get(cur.parentId) : undefined;
    }
    return false;
  };
  const placed = nodes.filter((n) => !isInTray(n));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const n of placed) {
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }
  function buildOne(n: OrgNode): Tree {
    const kids = childrenOf.get(n.id) ?? [];
    const persons = kids.filter((k) => k.kind === "person");
    const subDepts = kids.filter((k) => k.kind === "department");
    const children = subDepts.map(buildOne);
    const total =
      persons.length + children.reduce((acc, c) => acc + c.totalMembers, 0);
    return {
      node: n,
      leaders: persons.filter((p) => p.roleLabel),
      members: persons.filter((p) => !p.roleLabel),
      children,
      totalMembers: total,
    };
  }
  const roots = (childrenOf.get(null) ?? [])
    .filter((n) => n.kind === "department")
    .map(buildOne);
  return roots;
}

/**
 * Resolve the same color a tree-view dept card would render with. Keeping the
 * single source of truth in `lib/palette.ts` lets us guarantee the list view
 * and the canvas always agree on which color belongs to which dept — the
 * user has been clear that the two views must be visually consistent.
 */
function nodeColor(node: OrgNode): string {
  if (node.category === "ROOT") return ROOT_COLOR.header;
  if (node.category === "Exe") return EXE_COLOR.header;
  return colorAt(node.colorIndex).header;
}

/* ───────────────────── Inline-editable chip ───────────────────── */

function PersonChip({
  person,
  parentId,
  viewOnly,
  parentAccent,
}: {
  person: OrgNode;
  parentId: string | null;
  viewOnly: boolean;
  /** Used to color the leader role-badge so it matches the containing dept. */
  parentAccent: string;
}) {
  const setSelected = useOrgStore((s) => s.setSelected);
  const selectedId = useOrgStore((s) => s.selectedId);
  const rename = useOrgStore((s) => s.rename);
  const reparent = useOrgStore((s) => s.reparent);
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const setToast = useOrgStore((s) => s.setToast);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.name);

  const isLeader = !!person.roleLabel;
  const accent = isLeader ? parentAccent : "transparent";

  function startDrag(e: DragEvent) {
    if (viewOnly) {
      e.preventDefault();
      return;
    }
    // Stop the dragstart from bubbling up to the surrounding .lv-card; that
    // ancestor is also draggable=true and would otherwise also fire dragstart,
    // overwriting our person-drag state with a dept-drag and breaking the move.
    e.stopPropagation();
    e.dataTransfer.setData(PERSON_MIME, person.id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("is-being-dragged");
    setDragKind("person");
    useDndStore.getState().startDrag({
      id: person.id,
      kind: "person",
      label: person.name,
      source: "tree",
    });
  }

  function endDrag(e: DragEvent) {
    e.stopPropagation();
    e.currentTarget.classList.remove("is-being-dragged");
    setDragKind(null);
    useDndStore.getState().endDrag();
  }

  function handleDragOver(e: DragEvent) {
    if (viewOnly) return;
    if (!e.dataTransfer.types.includes(PERSON_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    e.stopPropagation();

    const dragging = useDndStore.getState().dragging;
    if (!dragging || dragging.id === person.id) return;
    const baseNodes = useOrgStore.getState().nodes;
    const reason = validateMove(baseNodes, dragging.id, parentId);
    if (reason) {
      useDndStore.getState().setHover("（無効な配置）", "invalid");
      useDndStore.getState().setPreview(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    const beforeAfter = e.clientX < r.left + r.width / 2 ? "before" : "after";
    const sibs = baseNodes.filter(
      (n) =>
        n.kind === "person" &&
        n.parentId === parentId &&
        !n.isUnplaced &&
        n.id !== dragging.id,
    );
    const idx = sibs.findIndex((s) => s.id === person.id);
    const atIndex = beforeAfter === "before" ? Math.max(0, idx) : idx + 1;
    const targetMeta = baseNodes.find((n) => n.id === parentId);
    useDndStore.getState().setHover(
      `${targetMeta?.name ?? ""}（${beforeAfter === "before" ? person.name + "の前" : person.name + "の後"}に）`,
      "valid",
    );
    useDndStore
      .getState()
      .setPreview({ sourceId: dragging.id, targetParentId: parentId, atIndex });
  }

  function handleDrop(e: DragEvent) {
    if (viewOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const pv = useDndStore.getState().preview;
    if (!pv) return;
    const isCopy = e.altKey;
    const res = isCopy
      ? duplicateAtPosition(pv.sourceId, pv.targetParentId, pv.atIndex)
      : reparent(pv.sourceId, pv.targetParentId, pv.atIndex);
    useDndStore.getState().endDrag();
    if (!res.ok && res.reason && res.reason !== "既に同じ親です") {
      setToast({ kind: "error", message: res.reason });
    }
  }

  function commit() {
    if (draft.trim() && draft.trim() !== person.name) {
      rename(person.id, draft.trim());
    }
    setEditing(false);
  }

  function onEditKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditing(false);
    }
  }

  const cls = [
    "lv-chip",
    isLeader ? "lv-chip--leader" : "lv-chip--member",
    selectedId === person.id ? "is-selected" : "",
    person.isExecutive ? "lv-chip--exec" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (editing) {
    return (
      <input
        className="lv-chip lv-chip--editing"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onEditKey}
        onClick={(e) => e.stopPropagation()}
      />
    );
  }

  return (
    <div
      className={cls}
      draggable={!viewOnly}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={(e) => {
        e.stopPropagation();
        setSelected(person.id);
      }}
      onDoubleClick={(e) => {
        if (viewOnly) return;
        e.stopPropagation();
        setDraft(person.name);
        setEditing(true);
      }}
      title={
        person.roleLabel
          ? `${person.roleLabel}：${person.name}${person.isExecutive ? "（役員）" : ""}${person.isConcurrent ? "（兼務）" : ""}（ダブルクリックで編集）`
          : `${person.name}${person.isConcurrent ? "（兼務）" : ""}（ダブルクリックで編集）`
      }
    >
      {isLeader && (
        <span
          className="lv-chip__role"
          style={{ background: accent, color: "#fff" }}
        >
          {person.roleLabel}
        </span>
      )}
      <span className="lv-chip__name">
        {person.isConcurrent && !person.name.startsWith("*") ? `*${person.name}` : person.name}
      </span>
      {person.isExecutive && <span className="lv-chip__badge">役員</span>}
      {person.isConcurrent && <span className="lv-chip__badge lv-chip__badge--concurrent">兼務</span>}
    </div>
  );
}

/* ─────────────── Inline-editable framed dept card ─────────────── */

function DeptCard({
  tree,
  parentId,
  indexInParent,
  viewOnly,
  depth = 0,
}: {
  tree: Tree;
  parentId: string | null;
  indexInParent: number;
  viewOnly: boolean;
  depth?: number;
}) {
  const { node, leaders, members, children, totalMembers } = tree;
  const setSelected = useOrgStore((s) => s.setSelected);
  const selectedId = useOrgStore((s) => s.selectedId);
  const rename = useOrgStore((s) => s.rename);
  const reparent = useOrgStore((s) => s.reparent);
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const setToast = useOrgStore((s) => s.setToast);
  const addPerson = useOrgStore((s) => s.addPerson);

  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(node.name);
  const cardRef = useRef<HTMLDivElement>(null);
  // Default-open levels: ROOT / Exe / DIV / TM. Anything below TM (Unit, plain
  // DEPT, etc.) starts collapsed so the user opens individual teams to see
  // member-level detail. This matches the user's directive about default
  // depth ("TMまではデフォルトで開いており、TM以下は閉じている").
  const defaultOpen =
    node.category === "ROOT" ||
    node.category === "Exe" ||
    node.category === "DIV" ||
    node.category === "TM";
  const [open, setOpen] = useState(defaultOpen);

  const accent = nodeColor(node);
  const isRoot = node.category === "ROOT";
  const sizeClass = `lv-card--${(node.category ?? "DEPT").toLowerCase()}`;
  const hasContent = leaders.length > 0 || members.length > 0 || children.length > 0;

  function startDrag(e: DragEvent) {
    if (viewOnly || isRoot) {
      e.preventDefault();
      return;
    }
    // Only handle dragstart that originated on the card itself. If a child
    // chip/button initiated the drag, ignore here.
    if (e.target !== e.currentTarget) return;
    e.dataTransfer.setData(DEPT_MIME, node.id);
    e.dataTransfer.effectAllowed = "move";
    e.currentTarget.classList.add("is-being-dragged");
    setDragKind("dept");
    useDndStore.getState().startDrag({
      id: node.id,
      kind: "dept",
      label: node.name,
      source: "tree",
    });
  }

  function endDrag(e: DragEvent) {
    e.currentTarget.classList.remove("is-being-dragged");
    setDragKind(null);
    useDndStore.getState().endDrag();
  }

  function clearHoverClasses(target: HTMLElement) {
    target.classList.remove("is-drop-before");
    target.classList.remove("is-drop-after");
    target.classList.remove("is-drop-child");
  }

  function handleDragOver(e: DragEvent) {
    if (viewOnly) return;
    const types = e.dataTransfer.types;
    const isPerson = types.includes(PERSON_MIME);
    const isDept = types.includes(DEPT_MIME);
    if (!isPerson && !isDept) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = e.altKey ? "copy" : "move";
    e.stopPropagation();
    const dragging = useDndStore.getState().dragging;
    if (!dragging) return;
    const baseNodes = useOrgStore.getState().nodes;
    const target = e.currentTarget as HTMLElement;
    clearHoverClasses(target);

    if (isDept) {
      // Top 22% of card → before, bottom 22% → after, middle → child.
      const r = target.getBoundingClientRect();
      const localY = e.clientY - r.top;
      const h = r.height;
      let intent: "before" | "after" | "child";
      if (localY < h * 0.22) intent = "before";
      else if (localY > h * 0.78) intent = "after";
      else intent = "child";

      let targetParentId: string | null;
      let atIndex: number;
      if (intent === "child") {
        targetParentId = node.id;
        atIndex = Number.MAX_SAFE_INTEGER;
      } else {
        targetParentId = parentId;
        const sibs = baseNodes.filter(
          (n) =>
            n.kind === "department" &&
            n.parentId === parentId &&
            !n.isUnplaced &&
            n.id !== dragging.id,
        );
        const idx = sibs.findIndex((s) => s.id === node.id);
        atIndex = intent === "before" ? Math.max(0, idx) : idx + 1;
      }
      const reason = validateMove(baseNodes, dragging.id, targetParentId);
      if (reason) {
        useDndStore.getState().setHover(node.name, "invalid");
        useDndStore.getState().setPreview(null);
        return;
      }
      const labelSuffix =
        intent === "child"
          ? "（配下に）"
          : intent === "before"
            ? "（直前に）"
            : "（直後に）";
      useDndStore.getState().setHover(`${node.name}${labelSuffix}`, "valid");
      useDndStore
        .getState()
        .setPreview({ sourceId: dragging.id, targetParentId, atIndex });
      target.classList.add(`is-drop-${intent}`);
      return;
    }

    if (isPerson) {
      // Find the deepest "people row" under the cursor; otherwise default
      // to "append at end of this dept".
      const reason = validateMove(baseNodes, dragging.id, node.id);
      if (reason) {
        useDndStore.getState().setHover(node.name, "invalid");
        useDndStore.getState().setPreview(null);
        return;
      }
      // Detect insertion among direct chips (those rendered in this card's
      // .lv-card__people, not inside .lv-card__children).
      const peopleRow = target.querySelector<HTMLElement>(":scope > .lv-card__body > .lv-card__people");
      let chipIdx = 0;
      if (peopleRow) {
        const chips = Array.from(
          peopleRow.querySelectorAll<HTMLElement>(".lv-chip:not(.lv-chip--editing)"),
        );
        chipIdx = chips.length;
        for (let i = 0; i < chips.length; i++) {
          const r = chips[i].getBoundingClientRect();
          // Same row check: cursor Y within chip's row band
          const inRow = e.clientY >= r.top && e.clientY <= r.bottom;
          if (inRow && e.clientX < r.left + r.width / 2) {
            chipIdx = i;
            break;
          }
          if (e.clientY < r.top) {
            chipIdx = i;
            break;
          }
        }
      }
      useDndStore
        .getState()
        .setHover(`${node.name}（${chipIdx === 0 ? "先頭" : "末尾"}に）`, "valid");
      useDndStore
        .getState()
        .setPreview({ sourceId: dragging.id, targetParentId: node.id, atIndex: chipIdx });
      target.classList.add("is-drop-child");
    }
  }

  function handleDragLeave(e: DragEvent) {
    clearHoverClasses(e.currentTarget as HTMLElement);
  }

  function handleDrop(e: DragEvent) {
    if (viewOnly) return;
    clearHoverClasses(e.currentTarget as HTMLElement);
    e.preventDefault();
    e.stopPropagation();
    const pv = useDndStore.getState().preview;
    if (!pv) return;
    const isCopy = e.altKey;
    const res = isCopy
      ? duplicateAtPosition(pv.sourceId, pv.targetParentId, pv.atIndex)
      : reparent(pv.sourceId, pv.targetParentId, pv.atIndex);
    useDndStore.getState().endDrag();
    if (!res.ok && res.reason && res.reason !== "既に同じ親です") {
      setToast({ kind: "error", message: res.reason });
    }
  }

  function commitName() {
    if (draft.trim() && draft.trim() !== node.name) {
      rename(node.id, draft.trim());
    }
    setEditingName(false);
  }

  function onEditKey(e: KeyboardEvent<HTMLInputElement>) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commitName();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingName(false);
    }
  }

  // Touch indexInParent so eslint doesn't complain when sibling reorder
  // doesn't need it directly (it's used by parent component).
  void indexInParent;

  const directCount = leaders.length + members.length;
  const showPeopleRow = directCount > 0 || !viewOnly;

  return (
    <div
      ref={cardRef}
      className={`lv-card ${sizeClass} ${selectedId === node.id ? "is-selected" : ""} ${open ? "is-open" : "is-closed"}`}
      style={{ ["--lv-accent" as string]: accent }}
      data-depth={depth}
      draggable={!viewOnly && !isRoot}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onDragOver={(e) => {
        // Auto-expand on drag-hover so the user can drop into a collapsed
        // dept without manually opening it first. We only auto-open; we
        // never auto-close (would be jumpy).
        if (!open && hasContent) setOpen(true);
        handleDragOver(e);
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(e) => {
        e.stopPropagation();
        setSelected(node.id);
      }}
    >
      <div className="lv-card__header">
        <button
          type="button"
          className="lv-card__chevron"
          draggable={false}
          onMouseDown={(e) => {
            // Prevent the parent .lv-card draggable from starting a drag when
            // the user is just trying to toggle the accordion.
            e.stopPropagation();
          }}
          onClick={(e) => {
            e.stopPropagation();
            if (hasContent) setOpen((v) => !v);
          }}
          aria-label={open ? "閉じる" : "開く"}
          aria-expanded={open}
          disabled={!hasContent}
          title={hasContent ? (open ? "閉じる" : "開く") : "（配下なし）"}
        >
          <span className={`lv-card__chevron-icon ${open ? "is-open" : ""}`}>▸</span>
        </button>
        <span className="lv-card__category" style={{ background: accent }}>
          {node.category ?? "DEPT"}
        </span>
        {editingName ? (
          <input
            className="lv-card__nameInput"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={onEditKey}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="lv-card__name"
            onDoubleClick={(e) => {
              if (viewOnly || isRoot) return;
              e.stopPropagation();
              setDraft(node.name);
              setEditingName(true);
            }}
            title={
              isRoot || viewOnly
                ? node.name
                : `${node.name}（ダブルクリックで編集）`
            }
          >
            {node.name}
          </span>
        )}
        <span className="lv-card__counts">
          直{directCount}・配下計{totalMembers}
        </span>
      </div>

      {open && (
      <div className="lv-card__body">
        {showPeopleRow && (
          <div className="lv-card__people">
            {leaders.map((p) => (
              <PersonChip
                key={p.id}
                person={p}
                parentId={node.id}
                viewOnly={viewOnly}
                parentAccent={accent}
              />
            ))}
            {members.map((p) => (
              <PersonChip
                key={p.id}
                person={p}
                parentId={node.id}
                viewOnly={viewOnly}
                parentAccent={accent}
              />
            ))}
            {!viewOnly && (
              <button
                type="button"
                className="lv-add-chip"
                onClick={(e) => {
                  e.stopPropagation();
                  addPerson(node.id, { placed: true });
                }}
                title="この部署に人員を追加"
              >
                ＋
              </button>
            )}
          </div>
        )}

        {children.length > 0 && (
          <div className="lv-card__children">
            {children.map((c, i) => (
              <DeptCard
                key={c.node.id}
                tree={c}
                parentId={node.id}
                indexInParent={i}
                viewOnly={viewOnly}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

export function ListView() {
  const baseNodes = useOrgStore((s) => s.nodes);
  const versionLabel = useOrgStore((s) => s.currentVersionLabel);
  const sharedLabel = useUiStore((s) => s.sharedVersionLabel);
  const viewOnly = useUiStore((s) => s.viewOnly);

  // Tree is built from the canonical store state; we do NOT apply the
  // in-flight drag preview to the layout (that caused the whole list to
  // reflow on every mouse move and made dropping awkward). Drop intent is
  // shown via the per-target is-drop-before/after/child classes set
  // imperatively in handleDragOver.
  const trees = useMemo(() => buildTree(baseNodes), [baseNodes]);
  const headline = viewOnly ? sharedLabel : versionLabel;

  return (
    <div className="list-view">
      <div className="list-view__paper">
        <header className="list-view__head">
          <div>
            <div className="list-view__brandline">OrgChart Studio</div>
            <h1 className="list-view__title">組織体制図</h1>
            {headline && <div className="list-view__subtitle">{headline}</div>}
          </div>
          <div className="list-view__date">
            {new Date().toLocaleDateString("ja-JP", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}{" "}
            時点
          </div>
        </header>

        <div className="list-view__legend">
          <span
            className="lv-legend__chip"
            style={{ background: ROOT_COLOR.header }}
            title="会社/組織のルート"
          >
            ROOT
          </span>
          <span
            className="lv-legend__chip"
            style={{ background: EXE_COLOR.header }}
            title="役員レイヤー"
          >
            Exe
          </span>
          <span className="list-view__hint">
            DIV／TM／Unit はインスペクターで設定したカラーがツリービューと連動して表示されます。
          </span>
          {!viewOnly && (
            <span className="list-view__hint">
              ・ヘッダーをクリックで開閉 ・チップをドラッグで並び替え ・ダブルクリックで名前編集
            </span>
          )}
        </div>

        <div className="list-view__body">
          {trees.length === 0 ? (
            <p className="list-view__empty">表示する組織がありません。</p>
          ) : (
            trees.map((t, i) => (
              <DeptCard
                key={t.node.id}
                tree={t}
                parentId={null}
                indexInParent={i}
                viewOnly={viewOnly}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
