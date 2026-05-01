import type { OrgNode } from "./types";
import { descendantsOf, wouldCreateCycle } from "./layout";

function uid(kind: OrgNode["kind"]): string {
  const prefix = kind === "person" ? "p" : "d";
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
}

/**
 * Deep-clone a subtree (rootId + all descendants) with fresh ids. Internal
 * parent links are remapped to the new ids; the root's parentId is preserved
 * so the caller can decide where to attach the clone.
 */
export function cloneSubtree(
  allNodes: OrgNode[],
  rootId: string,
): { clones: OrgNode[]; newRootId: string; idMap: Map<string, string> } {
  const root = allNodes.find((n) => n.id === rootId);
  if (!root) return { clones: [], newRootId: rootId, idMap: new Map() };

  const subtree = [root, ...descendantsOf(allNodes, rootId)];
  const idMap = new Map<string, string>();
  for (const n of subtree) idMap.set(n.id, uid(n.kind));

  const clones = subtree.map((n) => ({
    ...n,
    id: idMap.get(n.id)!,
    parentId:
      n.parentId && idMap.has(n.parentId) ? idMap.get(n.parentId)! : n.parentId,
  }));

  return { clones, newRootId: idMap.get(rootId)!, idMap };
}

/** Same-kind sibling slots under a given parent, in current array order. */
function siblingsUnder(
  nodes: OrgNode[],
  parentId: string | null,
  kind: OrgNode["kind"],
  excludeId?: string,
): OrgNode[] {
  return nodes.filter(
    (n) =>
      n.kind === kind &&
      n.parentId === parentId &&
      !n.isUnplaced &&
      n.id !== excludeId,
  );
}

/**
 * Compute a hypothetical nodes array with the given move applied. Used both
 * for preview rendering (the canvas reflows live as you drag) and for
 * committing on drop (the same algorithm is replayed inside useOrgStore).
 *
 * `atIndex` is the position among same-kind siblings of `targetParentId`
 * AFTER the move. Use a number >= sibling count to append.
 */
export function applyMove(
  nodes: OrgNode[],
  sourceId: string,
  targetParentId: string | null,
  atIndex: number,
): OrgNode[] {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source) return nodes;

  const without = nodes.filter((n) => n.id !== sourceId);
  const updated: OrgNode = {
    ...source,
    parentId: targetParentId,
    isUnplaced: false,
  };

  const siblings = siblingsUnder(without, targetParentId, source.kind);

  let insertAt: number;
  if (siblings.length === 0) {
    // No siblings: place after the parent node, or at end if parent is null
    if (targetParentId) {
      const parentIdx = without.findIndex((n) => n.id === targetParentId);
      insertAt = parentIdx >= 0 ? parentIdx + 1 : without.length;
    } else {
      insertAt = without.length;
    }
  } else if (atIndex >= siblings.length) {
    const last = siblings[siblings.length - 1];
    insertAt = without.indexOf(last) + 1;
  } else {
    const at = siblings[Math.max(0, atIndex)];
    insertAt = without.indexOf(at);
  }

  return [...without.slice(0, insertAt), updated, ...without.slice(insertAt)];
}

/** Validate a hypothetical move. Returns null if ok, or a reason string. */
export function validateMove(
  nodes: OrgNode[],
  sourceId: string,
  targetParentId: string | null,
): string | null {
  const source = nodes.find((n) => n.id === sourceId);
  if (!source) return "対象ノードが見つかりません";

  if (source.kind === "person") {
    if (targetParentId === null) return "人員は部署の中にのみ配置できます";
    const target = nodes.find((n) => n.id === targetParentId);
    if (!target || target.kind !== "department") {
      return "人員は部署の中にのみ配置できます";
    }
  } else {
    if (targetParentId !== null) {
      const target = nodes.find((n) => n.id === targetParentId);
      if (!target) return "ドロップ先が見つかりません";
      if (target.kind === "person") {
        return "部署を人員の下に置くことはできません";
      }
    }
    if (wouldCreateCycle(nodes, sourceId, targetParentId)) {
      return "循環参照になるため移動できません";
    }
  }

  return null;
}
