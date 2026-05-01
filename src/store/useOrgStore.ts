import { create } from "zustand";
import type { AppState, LogEntry, OrgNode, PersonRole, DeptCategory } from "../lib/types";
import { seedData } from "../lib/seed";
import { descendantsOf, wouldCreateCycle } from "../lib/layout";
import { applyMove } from "../lib/move";

const STORAGE_KEY = "org-chart-prototype:v2";
const LOG_LIMIT = 10;
const HISTORY_LIMIT = 50;

type DeleteWithChildrenStrategy = "cascade" | "promoteToRoot";

type Snapshot = Pick<AppState, "nodes">;

type Store = AppState & {
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  /** id of the server-side version currently displayed (null when seed/local-only) */
  currentVersionId: string | null;
  /** label shown next to the dirty/saved badge */
  currentVersionLabel: string | null;

  addDepartment: (parentId: string | null, opts?: { category?: DeptCategory; colorIndex?: number }) => void;
  addPerson: (parentId: string | null, opts?: { roleLabel?: PersonRole }) => void;
  addExecutive: (role: NonNullable<PersonRole>) => void;
  deleteNode: (id: string, strategy?: DeleteWithChildrenStrategy) => void;
  rename: (id: string, name: string) => void;
  setRole: (id: string, roleLabel: PersonRole) => void;
  setExecutive: (id: string, isExecutive: boolean) => void;
  setCategory: (id: string, category: DeptCategory) => void;
  setColor: (id: string, colorIndex: number) => void;
  reparent: (
    nodeId: string,
    newParentId: string | null,
    atIndex?: number,
  ) => { ok: boolean; reason?: string };
  setSelected: (id: string | null) => void;
  setToast: (toast: AppState["toast"]) => void;

  undo: () => void;
  redo: () => void;
  reset: () => void;
  saveDraft: () => void;
  loadFromStorage: () => void;
  replaceNodes: (nodes: OrgNode[], meta?: { versionId?: string; versionLabel?: string }) => void;
  markClean: (meta?: { versionId?: string; versionLabel?: string }) => void;
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
}

function makeLog(action: LogEntry["action"], detail: string): LogEntry {
  return { id: uid("log"), ts: Date.now(), action, detail };
}

function pushLog(log: LogEntry[], entry: LogEntry): LogEntry[] {
  return [entry, ...log].slice(0, LOG_LIMIT);
}

function snapshot(state: Pick<AppState, "nodes">): Snapshot {
  return { nodes: state.nodes.map((n) => ({ ...n })) };
}

/** Person nodes always belong to a department; if a non-dept target is given, walk up to the nearest dept. */
function nearestDeptAncestor(nodes: OrgNode[], parentId: string | null): string | null {
  let cur = parentId;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  while (cur) {
    const node = byId.get(cur);
    if (!node) return null;
    if (node.kind === "department") return node.id;
    cur = node.parentId;
  }
  return null;
}

export const useOrgStore = create<Store>((set, get) => ({
  nodes: seedData(),
  selectedId: null,
  log: [makeLog("reset", "初期データを読み込み")],
  toast: null,
  past: [],
  future: [],
  dirty: false,
  currentVersionId: null,
  currentVersionLabel: null,

  addDepartment: (parentId, opts) => {
    const state = get();
    const id = uid("d");
    // New nodes always land in the tray (isUnplaced=true). The user drags
    // them onto the canvas to commit a parent. parentId here is treated as a
    // *hint* for the default category and color when they eventually drop.
    const hintParent = parentId ? state.nodes.find((n) => n.id === parentId) : null;
    const inferred: DeptCategory = (() => {
      if (opts?.category) return opts.category;
      if (!hintParent) return "DIV";
      if (hintParent.category === "ROOT") return "Exe";
      if (hintParent.category === "Exe") return "DIV";
      if (hintParent.category === "DIV") return "TM";
      if (hintParent.category === "TM") return "Unit";
      return "DEPT";
    })();
    const colorIndex =
      opts?.colorIndex ??
      (hintParent?.colorIndex !== undefined && hintParent.category !== "ROOT"
        ? hintParent.colorIndex
        : state.nodes.filter((n) => n.kind === "department").length % 8);
    const newNode: OrgNode = {
      id,
      kind: "department",
      name: "新規部署",
      parentId: null,
      category: inferred,
      colorIndex,
      isUnplaced: true,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: pushLog(state.log, makeLog("add", `部署「${newNode.name}」（${inferred}）を未配置で追加`)),
      dirty: true,
      toast: { kind: "info", message: "未配置エリアに追加しました。ドラッグで配置先を指定してください" },
    });
  },

  addPerson: (parentId, opts) => {
    const state = get();
    const id = uid("p");
    const newNode: OrgNode = {
      id,
      kind: "person",
      name: "新規メンバー",
      parentId: null,
      roleLabel: opts?.roleLabel ?? null,
      isUnplaced: true,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: pushLog(state.log, makeLog("add", `人員「${newNode.name}」を未配置で追加`)),
      dirty: true,
      toast: { kind: "info", message: "未配置エリアに追加しました。ドラッグで配置先の部署を指定してください" },
    });
    // touch parentId to silence unused warning in dev
    void parentId;
  },

  addExecutive: (role) => {
    const state = get();
    const id = uid("p");
    const newNode: OrgNode = {
      id,
      kind: "person",
      name: "新規役員",
      parentId: null,
      roleLabel: role,
      isExecutive: true,
      isUnplaced: true,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: pushLog(state.log, makeLog("add", `役員「${newNode.name}」（${role}）を未配置で追加`)),
      dirty: true,
      toast: { kind: "info", message: "未配置エリアに追加しました。Exe部署にドラッグして配置してください" },
    });
  },

  setExecutive: (id, isExecutive) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target || target.kind !== "person") return;
    if (!!target.isExecutive === isExecutive) return;
    let nextParentId = target.parentId;
    // When toggling ON and parent is a non-root dept, also relocate to ROOT so
    // the person appears in the executive band by default. The user can
    // re-drop them onto a dept afterward.
    if (isExecutive) {
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const parent = target.parentId ? byId.get(target.parentId) : null;
      if (parent?.kind !== "department" || parent.category !== "ROOT") {
        const root = state.nodes.find(
          (n) => n.kind === "department" && n.category === "ROOT",
        );
        if (root) nextParentId = root.id;
      }
    }
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, isExecutive, parentId: nextParentId } : n,
      ),
      log: pushLog(
        state.log,
        makeLog("role", `「${target.name}」を${isExecutive ? "役員" : "通常メンバー"}に変更`),
      ),
      dirty: true,
    });
  },

  deleteNode: (id, strategy = "cascade") => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target) return;
    const descs = descendantsOf(state.nodes, id);
    let nextNodes: OrgNode[];
    let detail: string;
    if (strategy === "cascade") {
      const removeIds = new Set([id, ...descs.map((d) => d.id)]);
      nextNodes = state.nodes.filter((n) => !removeIds.has(n.id));
      detail = `「${target.name}」と配下${descs.length}件を削除`;
    } else {
      nextNodes = state.nodes
        .map((n) => (n.parentId === id ? { ...n, parentId: null } : n))
        .filter((n) => n.id !== id);
      detail = `「${target.name}」を削除（子をルートへ移動）`;
    }
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: nextNodes,
      selectedId: state.selectedId === id ? null : state.selectedId,
      log: pushLog(state.log, makeLog("delete", detail)),
      dirty: true,
    });
  },

  rename: (id, name) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target || target.name === name) return;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, name } : n)),
      log: pushLog(state.log, makeLog("rename", `「${target.name}」→「${name}」`)),
      dirty: true,
    });
  },

  setRole: (id, roleLabel) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target || target.kind !== "person") return;
    if (target.roleLabel === roleLabel) return;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, roleLabel } : n)),
      log: pushLog(state.log, makeLog("role", `「${target.name}」の役職を ${roleLabel ?? "メンバー"} に変更`)),
      dirty: true,
    });
  },

  setCategory: (id, category) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target || target.kind !== "department") return;
    if (target.category === category) return;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, category } : n)),
      log: pushLog(state.log, makeLog("rename", `「${target.name}」の種別を ${category} に変更`)),
      dirty: true,
    });
  },

  setColor: (id, colorIndex) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target || target.kind !== "department") return;
    if (target.colorIndex === colorIndex) return;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, colorIndex } : n)),
      dirty: true,
    });
  },

  reparent: (nodeId, newParentId, atIndex) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, reason: "対象ノードが見つかりません" };

    let resolvedParentId: string | null = newParentId;

    if (node.kind === "person") {
      resolvedParentId = nearestDeptAncestor(state.nodes, newParentId);
      if (newParentId !== null && resolvedParentId === null) {
        return { ok: false, reason: "人員は部署の中にのみ配置できます" };
      }
    } else if (newParentId !== null) {
      const target = state.nodes.find((n) => n.id === newParentId);
      if (!target) return { ok: false, reason: "ドロップ先が見つかりません" };
      if (target.kind === "person") {
        return { ok: false, reason: "部署を人員の下に置くことはできません" };
      }
    }

    if (wouldCreateCycle(state.nodes, nodeId, resolvedParentId)) {
      return { ok: false, reason: "循環参照になるため移動できません" };
    }

    // No-op: same parent, no atIndex specified, and node already placed.
    if (
      atIndex === undefined &&
      node.parentId === resolvedParentId &&
      !node.isUnplaced
    ) {
      return { ok: false, reason: "既に同じ親です" };
    }

    const desiredIndex = atIndex ?? Number.MAX_SAFE_INTEGER;
    const nextNodes = applyMove(state.nodes, nodeId, resolvedParentId, desiredIndex);

    const newParent = resolvedParentId
      ? state.nodes.find((n) => n.id === resolvedParentId)
      : null;
    const wasUnplaced = !!node.isUnplaced;
    const detail = wasUnplaced
      ? newParent
        ? `「${node.name}」を「${newParent.name}」配下に配置`
        : `「${node.name}」をルートに配置`
      : newParent
        ? `「${node.name}」を「${newParent.name}」配下に移動`
        : `「${node.name}」をルートへ移動`;

    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: nextNodes,
      log: pushLog(state.log, makeLog("move", detail)),
      dirty: true,
    });
    return { ok: true };
  },

  setSelected: (id) => set({ selectedId: id }),
  setToast: (toast) => set({ toast }),

  undo: () => {
    const state = get();
    if (state.past.length === 0) return;
    const prev = state.past[state.past.length - 1];
    set({
      past: state.past.slice(0, -1),
      future: [snapshot(state), ...state.future].slice(0, HISTORY_LIMIT),
      nodes: prev.nodes,
      dirty: true,
    });
  },

  redo: () => {
    const state = get();
    if (state.future.length === 0) return;
    const next = state.future[0];
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: state.future.slice(1),
      nodes: next.nodes,
      dirty: true,
    });
  },

  reset: () => {
    const state = get();
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: seedData(),
      selectedId: null,
      currentVersionId: null,
      currentVersionLabel: null,
      log: pushLog(state.log, makeLog("reset", "初期データへリセット")),
      dirty: true,
    });
  },

  saveDraft: () => {
    const state = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: state.nodes }));
    } catch {
      // ignore quota errors
    }
  },

  replaceNodes: (nodes, meta) => {
    const state = get();
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: nodes.map((n) => ({ ...n })),
      selectedId: null,
      currentVersionId: meta?.versionId ?? null,
      currentVersionLabel: meta?.versionLabel ?? null,
      dirty: false,
      log: pushLog(
        state.log,
        makeLog(
          "reset",
          meta?.versionLabel
            ? `バージョン「${meta.versionLabel}」を読み込みました`
            : "ノードを置き換えました",
        ),
      ),
    });
  },

  markClean: (meta) => {
    set({
      dirty: false,
      currentVersionId: meta?.versionId ?? get().currentVersionId,
      currentVersionLabel: meta?.versionLabel ?? get().currentVersionLabel,
      log: meta?.versionLabel
        ? pushLog(get().log, makeLog("save", `バージョン「${meta.versionLabel}」を保存`))
        : get().log,
    });
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { nodes?: OrgNode[] };
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) return;
      set({ nodes: parsed.nodes, dirty: false });
    } catch {
      // ignore corrupt storage
    }
  },
}));
