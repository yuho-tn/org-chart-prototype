import type { OrgNode } from "./types";

const NODE_W = 200;
const NODE_H = 80;
const H_GAP = 32;
const V_GAP = 80;

/**
 * Compute a tidy top-down tree layout. Multiple roots are placed side by side.
 * Returns a new array of nodes with x/y assigned.
 */
export function layout(nodes: OrgNode[]): OrgNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }

  const widthCache = new Map<string, number>();
  function subtreeWidth(id: string): number {
    if (widthCache.has(id)) return widthCache.get(id)!;
    const kids = childrenOf.get(id) ?? [];
    if (kids.length === 0) {
      widthCache.set(id, NODE_W);
      return NODE_W;
    }
    const w = kids.reduce((acc, k, i) => acc + subtreeWidth(k.id) + (i > 0 ? H_GAP : 0), 0);
    const total = Math.max(NODE_W, w);
    widthCache.set(id, total);
    return total;
  }

  const result = new Map<string, { x: number; y: number }>();
  function place(id: string, left: number, depth: number) {
    const kids = childrenOf.get(id) ?? [];
    const myWidth = subtreeWidth(id);
    const cx = left + myWidth / 2;
    result.set(id, { x: cx - NODE_W / 2, y: depth * (NODE_H + V_GAP) });
    let cursor = left;
    for (const k of kids) {
      const w = subtreeWidth(k.id);
      place(k.id, cursor, depth + 1);
      cursor += w + H_GAP;
    }
  }

  const roots = childrenOf.get(null) ?? [];
  let cursor = 0;
  for (const r of roots) {
    const w = subtreeWidth(r.id);
    place(r.id, cursor, 0);
    cursor += w + H_GAP;
  }

  return nodes.map((n) => {
    const pos = result.get(n.id);
    return pos ? { ...n, x: pos.x, y: pos.y } : n;
  });
}

/** Returns true if making `targetId` the parent of `nodeId` would create a cycle. */
export function wouldCreateCycle(
  nodes: OrgNode[],
  nodeId: string,
  targetId: string | null,
): boolean {
  if (targetId === null) return false;
  if (nodeId === targetId) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur: string | null = targetId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === nodeId) return true;
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = byId.get(cur)?.parentId ?? null;
  }
  return false;
}

/** Get all descendants (not including the node itself). */
export function descendantsOf(nodes: OrgNode[], id: string): OrgNode[] {
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }
  const out: OrgNode[] = [];
  function walk(curId: string) {
    const kids = childrenOf.get(curId) ?? [];
    for (const k of kids) {
      out.push(k);
      walk(k.id);
    }
  }
  walk(id);
  return out;
}
