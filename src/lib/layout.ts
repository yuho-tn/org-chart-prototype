import type { OrgNode } from "./types";

export const CARD_W = 220;
export const HEADER_H = 40;
export const LEADER_ROW_H = 26;
export const MEMBER_ROW_H = 24;
export const CARD_PAD_TOP = 4;
export const CARD_PAD_BOTTOM = 10;
export const CARD_GAP_X = 28;
export const CARD_GAP_Y = 56;

export type DeptSize = { w: number; h: number };

export type LaidOutDept = OrgNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export function deptHeight(persons: { roleLabel?: OrgNode["roleLabel"] }[]): number {
  const leaders = persons.filter((p) => p.roleLabel).length;
  const members = persons.length - leaders;
  return (
    HEADER_H +
    CARD_PAD_TOP +
    leaders * LEADER_ROW_H +
    members * MEMBER_ROW_H +
    CARD_PAD_BOTTOM
  );
}

/**
 * Tidy top-down layout for the department tree. Persons are rendered inside
 * their parent's card and do not receive coordinates here.
 */
export function layoutDepartments(nodes: OrgNode[]): {
  depts: LaidOutDept[];
  byId: Map<string, LaidOutDept>;
} {
  const depts = nodes.filter((n) => n.kind === "department");
  const persons = nodes.filter((n) => n.kind === "person");

  const personsOfDept = new Map<string, OrgNode[]>();
  for (const p of persons) {
    if (!p.parentId) continue;
    const arr = personsOfDept.get(p.parentId) ?? [];
    arr.push(p);
    personsOfDept.set(p.parentId, arr);
  }

  const childDepts = new Map<string | null, OrgNode[]>();
  for (const d of depts) {
    const arr = childDepts.get(d.parentId) ?? [];
    arr.push(d);
    childDepts.set(d.parentId, arr);
  }

  const sizes = new Map<string, DeptSize>();
  for (const d of depts) {
    const ps = personsOfDept.get(d.id) ?? [];
    sizes.set(d.id, { w: CARD_W, h: deptHeight(ps) });
  }

  // Depth of each dept (root depts at depth 0)
  const depth = new Map<string, number>();
  function dfsDepth(id: string, dep: number) {
    depth.set(id, dep);
    for (const k of childDepts.get(id) ?? []) dfsDepth(k.id, dep + 1);
  }
  for (const r of childDepts.get(null) ?? []) dfsDepth(r.id, 0);

  // Row baseline y per depth (cumulative max heights)
  const rowMaxH = new Map<number, number>();
  for (const d of depts) {
    const dep = depth.get(d.id) ?? 0;
    const h = sizes.get(d.id)!.h;
    rowMaxH.set(dep, Math.max(rowMaxH.get(dep) ?? 0, h));
  }
  const yAt = new Map<number, number>();
  const maxDepth = Math.max(0, ...rowMaxH.keys());
  let cumY = 0;
  for (let d = 0; d <= maxDepth; d++) {
    yAt.set(d, cumY);
    cumY += (rowMaxH.get(d) ?? 0) + CARD_GAP_Y;
  }

  // Subtree width
  const widthCache = new Map<string, number>();
  function subtreeWidth(id: string): number {
    if (widthCache.has(id)) return widthCache.get(id)!;
    const kids = childDepts.get(id) ?? [];
    if (kids.length === 0) {
      widthCache.set(id, CARD_W);
      return CARD_W;
    }
    const sum = kids.reduce(
      (acc, k, i) => acc + subtreeWidth(k.id) + (i > 0 ? CARD_GAP_X : 0),
      0,
    );
    const w = Math.max(CARD_W, sum);
    widthCache.set(id, w);
    return w;
  }

  const out = new Map<string, LaidOutDept>();
  function place(id: string, left: number) {
    const w = subtreeWidth(id);
    const cx = left + w / 2;
    const dep = depth.get(id) ?? 0;
    const meta = depts.find((d) => d.id === id)!;
    const sz = sizes.get(id)!;
    out.set(id, {
      ...meta,
      x: cx - sz.w / 2,
      y: yAt.get(dep) ?? 0,
      width: sz.w,
      height: sz.h,
    });
    let cursor = left;
    for (const k of childDepts.get(id) ?? []) {
      const kw = subtreeWidth(k.id);
      place(k.id, cursor);
      cursor += kw + CARD_GAP_X;
    }
  }

  let cursor = 0;
  for (const r of childDepts.get(null) ?? []) {
    const w = subtreeWidth(r.id);
    place(r.id, cursor);
    cursor += w + CARD_GAP_X;
  }

  return { depts: [...out.values()], byId: out };
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

export function descendantsOf(nodes: OrgNode[], id: string): OrgNode[] {
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const n of nodes) {
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }
  const out: OrgNode[] = [];
  function walk(curId: string) {
    for (const k of childrenOf.get(curId) ?? []) {
      out.push(k);
      walk(k.id);
    }
  }
  walk(id);
  return out;
}
