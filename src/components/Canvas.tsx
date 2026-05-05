import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type ReactFlowInstance,
  useReactFlow,
} from "reactflow";
import "reactflow/dist/style.css";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { DepartmentNode, type DeptNodeData } from "./DepartmentNode";
import { ExecutiveNode, type ExecNodeData } from "./ExecutiveNode";
import { isInExecutiveBand, layoutAll, wouldCreateCycle } from "../lib/layout";
import { setDragKind } from "../lib/dndState";
import { useDndStore } from "../store/useDndStore";
import { validateMove } from "../lib/move";
import { DragStatus } from "./DragStatus";
import type { OrgNode } from "../lib/types";

const nodeTypes = { department: DepartmentNode, executive: ExecutiveNode };

function buildDeptEdges(nodes: OrgNode[]): Edge[] {
  return nodes
    .filter((n) => n.kind === "department" && n.parentId)
    .map((n) => ({
      id: `e-${n.parentId}-${n.id}`,
      source: n.parentId!,
      target: n.id,
      type: "smoothstep",
    }));
}

type DropIntent = "before" | "after" | "child" | "invalid" | null;

type DragState = {
  draggingId: string | null;
  hoverId: string | null;
  intent: DropIntent;
};

export function Canvas() {
  const baseNodes = useOrgStore((s) => s.nodes);
  const selectedId = useOrgStore((s) => s.selectedId);
  const setSelected = useOrgStore((s) => s.setSelected);
  const reparent = useOrgStore((s) => s.reparent);
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const setToast = useOrgStore((s) => s.setToast);
  const viewOnly = useUiStore((s) => s.viewOnly);
  const employees = useEmployeesStore((s) => s.employees);
  const reactFlow = useReactFlow();

  // Person nodes that aren't linked to a row in the employee master are
  // flagged so the editor can warn the user up-front: announcements rely on
  // the master to compute hires / leaves / etc, and unlinked nodes drop out
  // of the diff silently. We treat both "no employeeNumber" and "FK no longer
  // resolves" (employee deleted from master) as unlinked.
  const validEmployeeNumbers = useMemo(() => {
    const s = new Set<string>();
    for (const e of employees) s.add(e.employee_number);
    return s;
  }, [employees]);
  function isPersonUnlinked(p: OrgNode): boolean {
    if (p.kind !== "person") return false;
    if (!p.employeeNumber) return true;
    return !validEmployeeNumbers.has(p.employeeNumber);
  }

  const [drag, setDrag] = useState<DragState>({
    draggingId: null,
    hoverId: null,
    intent: null,
  });
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // We deliberately do NOT apply the in-flight preview to the layout. Live
  // reflow on every mouse move was causing the surrounding tree to jitter and
  // intent to whip back-and-forth as the cursor crossed dept boundaries.
  // Instead, only the dragged node follows the cursor (handled by RF) and the
  // hovered target shows a colored insertion indicator. The actual move is
  // committed once on drop.
  const nodes = baseNodes;

  const layout = useMemo(() => layoutAll(nodes), [nodes]);
  const { depts: laidOutDepts, execs: laidOutExecs } = layout;

  const personsByParent = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const map = new Map<string, OrgNode[]>();
    for (const n of nodes) {
      if (n.kind !== "person" || !n.parentId) continue;
      // Skip persons that render in the executive band (they're rendered as
      // standalone RF nodes, not as chips in the parent dept's card).
      if (isInExecutiveBand(n, byId)) continue;
      const arr = map.get(n.parentId) ?? [];
      arr.push(n);
      map.set(n.parentId, arr);
    }
    return map;
  }, [nodes]);

  const rfNodes: Node<DeptNodeData | ExecNodeData>[] = useMemo(() => {
    const dnodes: Node<DeptNodeData>[] = laidOutDepts.map((d) => {
      const isDragging = drag.draggingId === d.id;
      const isHover = drag.hoverId === d.id;
      let dropState: "none" | "valid" | "invalid" = "none";
      let dropIntent: DropIntent = null;
      if (isHover && drag.draggingId && drag.draggingId !== d.id) {
        const cycle = wouldCreateCycle(nodes, drag.draggingId, d.id);
        dropState = cycle ? "invalid" : "valid";
        dropIntent = cycle ? "invalid" : drag.intent;
      }

      const persons = personsByParent.get(d.id) ?? [];
      const leaders = persons
        .filter((p) => !!p.roleLabel)
        .map((p) => ({
          id: p.id,
          name: p.name,
          roleLabel: p.roleLabel ?? null,
          selected: selectedId === p.id,
          isExecutive: !!p.isExecutive,
          isConcurrent: !!p.isConcurrent,
          isUnlinked: isPersonUnlinked(p),
        }));
      const members = persons
        .filter((p) => !p.roleLabel)
        .map((p) => ({
          id: p.id,
          name: p.name,
          selected: selectedId === p.id,
          isConcurrent: !!p.isConcurrent,
          isUnlinked: isPersonUnlinked(p),
        }));

      return {
        id: d.id,
        type: "department",
        position: { x: d.x, y: d.y },
        style: { width: d.width, height: d.height },
        data: {
          name: d.name,
          category: d.category ?? "DEPT",
          colorIndex: d.colorIndex ?? 0,
          selected: selectedId === d.id,
          isBeingDragged: isDragging,
          dropState,
          dropIntent,
          leaders,
          members,
          viewOnly,
        },
        draggable: !viewOnly,
        selectable: true,
      };
    });

    const enodes: Node<ExecNodeData>[] = laidOutExecs.map((e) => ({
      id: e.id,
      type: "executive",
      position: { x: e.x, y: e.y },
      style: { width: e.width, height: e.height },
      data: {
        name: e.name,
        role: e.roleLabel ?? null,
        selected: selectedId === e.id,
        isConcurrent: !!e.isConcurrent,
        isUnlinked: isPersonUnlinked(e),
      },
      draggable: false,
      selectable: true,
    }));

    return [...dnodes, ...enodes];
  }, [
    laidOutDepts,
    laidOutExecs,
    nodes,
    selectedId,
    drag,
    personsByParent,
    validEmployeeNumbers,
    viewOnly,
  ]);

  const rfEdges = useMemo(() => buildDeptEdges(nodes), [nodes]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelected(node.id),
    [setSelected],
  );

  const onPaneClick = useCallback(() => setSelected(null), [setSelected]);

  const onNodeDragStart: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type !== "department") return;
      setDrag({ draggingId: node.id, hoverId: null, intent: null });
      setDragKind("dept");
      const meta = nodes.find((n) => n.id === node.id);
      useDndStore.getState().startDrag({
        id: node.id,
        kind: "dept",
        label: meta?.name ?? node.id,
        source: "tree",
      });
    },
    [nodes],
  );

  const onNodeDrag: NodeMouseHandler = useCallback(
    (event, node) => {
      if (node.type !== "department") return;
      const native = event as unknown as MouseEvent;
      const rect = (native.target as HTMLElement | null)
        ?.closest(".react-flow")
        ?.getBoundingClientRect();
      if (!rect) return;
      const point = reactFlow.project({
        x: native.clientX - rect.left,
        y: native.clientY - rect.top,
      });
      // Find the closest dept under the cursor. Intent: "before" / "after"
      // if cursor is near the left/right quartile of the target, otherwise
      // "child". Hysteresis on intent (boundaries at 0.30 / 0.70 instead of
      // 0.25 / 0.75) keeps the indicator from flipping when the cursor
      // hovers right on the edge.
      let hoverId: string | null = null;
      let intent: "child" | "before" | "after" = "child";
      let bestDist = Infinity;
      for (const d of laidOutDepts) {
        if (d.id === node.id) continue;
        const cx = d.x + d.width / 2;
        const cy = d.y + d.height / 2;
        const dx = point.x - cx;
        const dy = point.y - cy;
        if (Math.abs(dx) < d.width / 2 + 24 && Math.abs(dy) < d.height / 2) {
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            hoverId = d.id;
            const localX = point.x - d.x;
            if (localX < d.width * 0.30) intent = "before";
            else if (localX > d.width * 0.70) intent = "after";
            else intent = "child";
          }
        }
      }

      if (hoverId === null) {
        const cur = dragRef.current;
        if (cur.hoverId !== null || cur.intent !== null) {
          setDrag({ draggingId: node.id, hoverId: null, intent: null });
          useDndStore.getState().setHover(null);
          useDndStore.getState().setPreview(null);
        }
        return;
      }
      const targetMeta = baseNodes.find((n) => n.id === hoverId);
      if (!targetMeta) return;

      let targetParentId: string | null;
      let atIndex: number;
      if (intent === "child") {
        targetParentId = hoverId;
        atIndex = Number.MAX_SAFE_INTEGER;
      } else {
        targetParentId = targetMeta.parentId;
        const siblings = baseNodes.filter(
          (n) =>
            n.kind === "department" &&
            n.parentId === targetParentId &&
            !n.isUnplaced &&
            n.id !== node.id,
        );
        const idx = siblings.findIndex((s) => s.id === hoverId);
        atIndex = intent === "before" ? Math.max(0, idx) : idx + 1;
      }

      const reason = validateMove(baseNodes, node.id, targetParentId);
      const cur = dragRef.current;
      if (reason) {
        useDndStore.getState().setHover(targetMeta.name, "invalid");
        useDndStore.getState().setPreview(null);
        if (cur.hoverId !== hoverId || cur.intent !== "invalid") {
          setDrag({ draggingId: node.id, hoverId, intent: "invalid" });
        }
        return;
      }

      const labelSuffix =
        intent === "child"
          ? "（配下に）"
          : intent === "before"
            ? "（左隣に）"
            : "（右隣に）";
      useDndStore.getState().setHover(`${targetMeta.name}${labelSuffix}`, "valid");
      // Only fire setPreview when the resolved drop point actually changes.
      // setPreview triggers a store update which re-renders the canvas; if
      // we set the same value on every mouse move we burn cycles for nothing.
      const prevPreview = useDndStore.getState().preview;
      if (
        !prevPreview ||
        prevPreview.sourceId !== node.id ||
        prevPreview.targetParentId !== targetParentId ||
        prevPreview.atIndex !== atIndex
      ) {
        useDndStore
          .getState()
          .setPreview({ sourceId: node.id, targetParentId, atIndex });
      }
      if (cur.hoverId !== hoverId || cur.intent !== intent) {
        setDrag({ draggingId: node.id, hoverId, intent });
      }
    },
    [laidOutDepts, baseNodes, reactFlow],
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (event, node) => {
      if (node.type !== "department") return;
      const finalPreview = useDndStore.getState().preview;
      const isCopy = !!(event as React.MouseEvent | undefined)?.altKey;
      setDrag({ draggingId: null, hoverId: null, intent: null });
      setDragKind(null);
      useDndStore.getState().endDrag();
      if (finalPreview) {
        const result = isCopy
          ? duplicateAtPosition(
              finalPreview.sourceId,
              finalPreview.targetParentId,
              finalPreview.atIndex,
            )
          : reparent(
              finalPreview.sourceId,
              finalPreview.targetParentId,
              finalPreview.atIndex,
            );
        if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
          setToast({ kind: "error", message: result.reason });
        }
        return;
      }
      // Fallback when no valid preview was registered (drop on empty canvas)
      const result = isCopy
        ? duplicateAtPosition(node.id, null, Number.MAX_SAFE_INTEGER)
        : reparent(node.id, null);
      if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
        setToast({ kind: "error", message: result.reason });
      }
    },
    [reparent, duplicateAtPosition, setToast],
  );

  const fitOnceRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    fitOnceRef.current?.fitView({ padding: 0.2, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laidOutDepts.length, laidOutExecs.length]);

  // Tray-originated dept drops anywhere on the canvas pane → place at root.
  const onPaneDragOver = useCallback((e: ReactDragEvent) => {
    if (e.dataTransfer.types.includes("application/x-dept-id")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const dragging = useDndStore.getState().dragging;
      if (dragging?.kind === "dept") {
        useDndStore.getState().setHover("（最上位／ルート）", "valid");
        useDndStore.getState().setPreview({
          sourceId: dragging.id,
          targetParentId: null,
          atIndex: Number.MAX_SAFE_INTEGER,
        });
      }
    }
  }, []);

  const onPaneDrop = useCallback(
    (e: ReactDragEvent) => {
      const deptId = e.dataTransfer.getData("application/x-dept-id");
      if (!deptId) return;
      e.preventDefault();
      const preview = useDndStore.getState().preview;
      const isCopy = e.altKey;
      const result = preview
        ? isCopy
          ? duplicateAtPosition(
              preview.sourceId,
              preview.targetParentId,
              preview.atIndex,
            )
          : reparent(
              preview.sourceId,
              preview.targetParentId,
              preview.atIndex,
            )
        : isCopy
          ? duplicateAtPosition(deptId, null, Number.MAX_SAFE_INTEGER)
          : reparent(deptId, null);
      useDndStore.getState().endDrag();
      if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
        setToast({ kind: "error", message: result.reason });
      }
    },
    [reparent, duplicateAtPosition, setToast],
  );

  const onPaneDragLeave = useCallback((e: ReactDragEvent) => {
    const wrapper = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as globalThis.Node | null;
    if (!related || !wrapper.contains(related)) {
      useDndStore.getState().setPreview(null);
      useDndStore.getState().setHover(null);
    }
  }, []);

  return (
    <div
      style={{ width: "100%", height: "100%" }}
      onDragOver={onPaneDragOver}
      onDrop={onPaneDrop}
      onDragLeave={onPaneDragLeave}
    >
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onInit={(inst) => {
        fitOnceRef.current = inst;
        inst.fitView({ padding: 0.2 });
      }}
      onNodeClick={onNodeClick}
      onPaneClick={onPaneClick}
      onNodeDragStart={viewOnly ? undefined : onNodeDragStart}
      onNodeDrag={viewOnly ? undefined : onNodeDrag}
      onNodeDragStop={viewOnly ? undefined : onNodeDragStop}
      nodesDraggable={!viewOnly}
      nodesConnectable={false}
      edgesFocusable={false}
      nodeDragThreshold={6}
      // Figma-style trackpad UX: two-finger scroll pans the canvas, pinch
      // zooms, ⌘/Ctrl + scroll also zooms (matches macOS conventions).
      // Click-and-drag on empty pane still pans for mouse users.
      panOnScroll
      panOnScrollSpeed={0.8}
      panOnDrag={[0, 1, 2]}
      selectionOnDrag={false}
      zoomOnScroll={false}
      zoomOnPinch
      zoomActivationKeyCode={["Meta", "Control"]}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep", style: { strokeWidth: 1.5 } }}
    >
      <Background gap={28} color="#e2e8f0" />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
    <DragStatus />
    </div>
  );
}
