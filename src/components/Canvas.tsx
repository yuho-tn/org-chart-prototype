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
import { DepartmentNode } from "./DepartmentNode";
import { PersonNode } from "./PersonNode";
import { layout, wouldCreateCycle } from "../lib/layout";
import type { OrgNode } from "../lib/types";

const nodeTypes = { department: DepartmentNode, person: PersonNode };

function buildEdges(nodes: OrgNode[]): Edge[] {
  return nodes
    .filter((n) => n.parentId)
    .map((n) => ({
      id: `e-${n.parentId}-${n.id}`,
      source: n.parentId!,
      target: n.id,
      type: "smoothstep",
    }));
}

function memberCount(nodes: OrgNode[], deptId: string): number {
  return nodes.filter((n) => n.parentId === deptId).length;
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

  const laidOut = useMemo(() => layout(nodes), [nodes]);

  const rfNodes: Node[] = useMemo(
    () =>
      laidOut.map((n) => {
        const isDragging = drag.draggingId === n.id;
        const isHover = drag.hoverId === n.id;
        let dropState: "none" | "valid" | "invalid" = "none";
        if (isHover && drag.draggingId && drag.draggingId !== n.id) {
          const cycle = wouldCreateCycle(nodes, drag.draggingId, n.id);
          dropState = cycle ? "invalid" : "valid";
        }
        return {
          id: n.id,
          type: n.kind,
          position: { x: n.x, y: n.y },
          data: {
            name: n.name,
            selected: selectedId === n.id,
            dropState,
            memberCount: n.kind === "department" ? memberCount(nodes, n.id) : 0,
          },
          draggable: true,
          selectable: true,
          dragging: isDragging,
        } as Node;
      }),
    [laidOut, nodes, selectedId, drag],
  );

  const rfEdges = useMemo(() => buildEdges(nodes), [nodes]);

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelected(node.id),
    [setSelected],
  );

  const onPaneClick = useCallback(() => setSelected(null), [setSelected]);

  const onNodeDragStart: NodeMouseHandler = useCallback((_, node) => {
    setDrag({ draggingId: node.id, hoverId: null });
  }, []);

  const onNodeDrag: NodeMouseHandler = useCallback(
    (event, node) => {
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
      const NODE_W = 200;
      const NODE_H = 80;
      for (const n of laidOut) {
        if (n.id === node.id) continue;
        const cx = n.x + NODE_W / 2;
        const cy = n.y + NODE_H / 2;
        const dx = point.x - cx;
        const dy = point.y - cy;
        if (Math.abs(dx) < NODE_W / 2 && Math.abs(dy) < NODE_H / 2) {
          const d = dx * dx + dy * dy;
          if (d < bestDist) {
            bestDist = d;
            bestId = n.id;
          }
        }
      }
      if (bestId !== dragRef.current.hoverId) {
        setDrag({ draggingId: node.id, hoverId: bestId });
      }
    },
    [laidOut, reactFlow],
  );

  const onNodeDragStop: NodeMouseHandler = useCallback(
    (_, node) => {
      const { hoverId } = dragRef.current;
      setDrag({ draggingId: null, hoverId: null });
      if (hoverId === null) {
        // dropped on empty space → make root
        const result = reparent(node.id, null);
        if (!result.ok && result.reason && result.reason !== "既に同じ親です") {
          setToast({ kind: "error", message: result.reason });
        }
        return;
      }
      const result = reparent(node.id, hoverId);
      if (!result.ok) {
        if (result.reason && result.reason !== "既に同じ親です") {
          setToast({ kind: "error", message: result.reason });
        }
      }
    },
    [reparent, setToast],
  );

  const fitOnceRef = useRef<ReactFlowInstance | null>(null);
  useEffect(() => {
    fitOnceRef.current?.fitView({ padding: 0.2, duration: 200 });
  }, [nodes.length]);

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
    >
      <Background gap={24} />
      <MiniMap pannable zoomable />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
