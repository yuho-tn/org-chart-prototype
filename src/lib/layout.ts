import type { OrgNode } from "./types";

export const CARD_W = 220;
export const HEADER_H = 40;
export const LEADER_ROW_H = 26;
export const MEMBER_ROW_H = 24;
export const CARD_PAD_TOP = 4;
// Reserve space at the bottom of every dept card for the inline "+ 人員を追加"
// button. Viewer mode renders one less element here but the extra padding is
// harmless (the card just feels a touch airier).
export const CARD_PAD_BOTTOM = 32;
export const CARD_GAP_X = 28;
// Slightly larger vertical gap so the "+" pill sitting just below each card
// (used to add a child dept) doesn't visually collide with the row beneath.
export const CARD_GAP_Y = 64;

export const EXEC_CARD_W = 144;
export const EXEC_CARD_H = 52;
export const EXEC_GAP_X = 12;
export const EXEC_BAND_PAD_Y = 32;

export type DeptSize = { w: number; h: number };

export type LaidOutDept = OrgNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LaidOutExec = OrgNode & {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LayoutResult = {
  depts: LaidOutDept[];
  execs: LaidOutExec[];
  byId: Map<string, LaidOutDept | LaidOutExec>;
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

/** Returns `true` if the person should render in the executive band rather than inside a dept card. */
export function isInExecutiveBand(node: OrgNode, byId: Map<string, OrgNode>): boolean {
  if (node.kind !== "person" || !node.isExecutive) return false;
  if (!node.parentId) return true;
  const parent = byId.get(node.parentId);
  return parent?.kind === "department" && parent.category === "ROOT";
}

export function layoutAll(nodes: OrgNode[]): LayoutResult {
  // Unplaced nodes live in the tray and never appear on the canvas. A pasted
  // dept brings its children with it: those children have isUnplaced=false but
  // their root ancestor is unplaced, so we walk up to filter the whole subtree.
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
  const byId = new Map(placed.map((n) => [n.id, n]));
  const depts = placed.filter((n) => n.kind === "department");
  const persons = placed.filter((n) => n.kind === "person");

  // Persons that should render *inside* a dept card (everyone except band-execs).
  const personsOfDept = new Map<string, OrgNode[]>();
  for (const p of persons) {
    if (!p.parentId) continue;
    if (isInExecutiveBand(p, byId)) continue;
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

  // Depth of each dept
  const depth = new Map<string, number>();
  function dfsDepth(id: string, dep: number) {
    depth.set(id, dep);
    for (const k of childDepts.get(id) ?? []) dfsDepth(k.id, dep + 1);
  }
  for (const r of childDepts.get(null) ?? []) dfsDepth(r.id, 0);

  const rowMaxH = new Map<number, number>();
  for (const d of depts) {
    const dep = depth.get(d.id) ?? 0;
    const h = sizes.get(d.id)!.h;
    rowMaxH.set(dep, Math.max(rowMaxH.get(dep) ?? 0, h));
  }

  // Determine if there is an executive band. The band lives between depth 0
  // (ROOT row) and depth 1 (DIV row). It pushes every depth >= 1 downward.
  const bandExecs = persons.filter((p) => isInExecutiveBand(p, byId));
  const hasBand = bandExecs.length > 0;
  const bandHeight = hasBand ? EXEC_CARD_H + EXEC_BAND_PAD_Y * 2 : 0;

  const yAt = new Map<number, number>();
  const maxDepth = Math.max(0, ...rowMaxH.keys());
  let cumY = 0;
  for (let d = 0; d <= maxDepth; d++) {
    yAt.set(d, cumY);
    const rowH = rowMaxH.get(d) ?? 0;
    cumY += rowH + CARD_GAP_Y;
    if (d === 0 && hasBand) cumY += bandHeight;
  }

  // Subtree widths
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

  // Compute executive band positions: a horizontal row centered across the
  // canvas width, sitting between the ROOT row and the DIV row.
  const execs: LaidOutExec[] = [];
  if (hasBand) {
    const totalW = bandExecs.length * EXEC_CARD_W + (bandExecs.length - 1) * EXEC_GAP_X;
    // Center horizontally across the union of all root subtree widths.
    const roots = childDepts.get(null) ?? [];
    const totalRootsW = roots.reduce(
      (acc, r, i) => acc + subtreeWidth(r.id) + (i > 0 ? CARD_GAP_X : 0),
      0,
    );
    const baseLeft = (totalRootsW - totalW) / 2;
    const rootMaxH = rowMaxH.get(0) ?? 0;
    const bandY = (yAt.get(0) ?? 0) + rootMaxH + EXEC_BAND_PAD_Y;
    bandExecs.forEach((p, i) => {
      execs.push({
        ...p,
        x: baseLeft + i * (EXEC_CARD_W + EXEC_GAP_X),
        y: bandY,
        width: EXEC_CARD_W,
        height: EXEC_CARD_H,
      });
    });
  }

  const merged = new Map<string, LaidOutDept | LaidOutExec>();
  for (const [k, v] of out) merged.set(k, v);
  for (const e of execs) merged.set(e.id, e);

  return { depts: [...out.values()], execs, byId: merged };
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
