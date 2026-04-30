import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DepartmentNode, type DeptNodeData } from "./DepartmentNode";
import { ExecutiveNode, type ExecNodeData } from "./ExecutiveNode";
import { isInExecutiveBand, layoutAll, wouldCreateCycle } from "../lib/layout";
import { setDragKind } from "../lib/dndState";
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

type DragState = {
  draggingId: string | null;
  hoverId: string | null;
};

export function Canvas() {
  const nodes = useOrgStore((s) => s.nodes);
  const selectedId = useOrgStore((s) => s.selectedId);
  const setSelected = useOrgStore((s) => s.setSelected);
  const reparent = useOrgStore((s) => s.reparent);
  const setToast = useOrgStore((s) => s.setToast);
  const reactFlow = useReactFlow();

  const [drag, setDrag] = useState<DragState>({ draggingId: null, hoverId: null });
  const dragRef = useRef(drag);
  dragRef.current = drag;

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
      if (isHover && drag.draggingId && drag.draggingId !== d.id) {
        const cycle = wouldCreateCycle(nodes, drag.draggingId, d.id);
        dropState = cycle ? "invalid" : "valid";
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
        }));
      const members = persons
        .filter((p) => !p.roleLabel)
        .map((p) => ({ id: p.id, name: p.name, selected: selectedId === p.id }));

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
          leaders,
          members,
        },
        draggable: true,
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
      },
      draggable: false,
      selectable: true,
    }));

    return [...dnodes, ...enodes];
  }, [laidOutDepts, laidOutExecs, nodes, selectedId, drag, personsByParent]);

  const rfEdges = useMemo(() => buildDeptEdges(nodes), [nodes]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelected(node.id),
    [setSelected],
  );

  const onPaneClick = useCallback(() => setSelected(null), [setSelected]);

  const onNodeDragStart: NodeMouseHandler = useCallback((_, node) => {
    if (node.type !== "department") return;
    setDrag({ draggingId: node.id, hoverId: null });
    setDragKind("dept");
  }, []);

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
      let bestId: string | null = null;
      let bestDist = Infinity;
      for (const d of laidOutDepts) {
        if (d.id === node.id) continue;
        const cx = d.x + d.width / 2;
        const cy = d.y + d.height / 2;
        const dx = point.x - cx;
        const dy = point.y - cy;
        if (Math.abs(dx) < d.width / 2 && Math.abs(dy) < d.height / 2) {
          const dist = dx * dx + dy * dy;
          if (dist < bestDist) {
            bestDist = dist;
            bestId = d.id;
          }
        }
      }
      if (bestId !== dragRef.current.hoverId) {
        setDrag({ draggingId: node.id, hoverId: bestId });
      }
    },
    [laidOutDepts, reactFlow],
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type !== "department") return;
      const { hoverId } = dragRef.current;
      setDrag({ draggingId: null, hoverId: null });
      setDragKind(null);
      if (hoverId === null) {
        const result = reparent(node.id, null);
        if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
          setToast({ kind: "error", message: result.reason });
        }
        return;
      }
      const result = reparent(node.id, hoverId);
      if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
        setToast({ kind: "error", message: result.reason });
      }
    },
    [reparent, setToast],
  );

  const fitOnceRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    fitOnceRef.current?.fitView({ padding: 0.2, duration: 200 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [laidOutDepts.length, laidOutExecs.length]);

  return (
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
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      nodesConnectable={false}
      edgesFocusable={false}
      proOptions={{ hideAttribution: true }}
      defaultEdgeOptions={{ type: "smoothstep", style: { strokeWidth: 1.5 } }}
    >
      <Background gap={28} color="#e2e8f0" />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
