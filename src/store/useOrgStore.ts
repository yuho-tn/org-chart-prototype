import { create } from "zustand";
import type { AppState, LogEntry, OrgNode } from "../lib/types";
import { seedData } from "../lib/seed";
import { descendantsOf, wouldCreateCycle } from "../lib/layout";

const STORAGE_KEY = "org-chart-prototype:v1";
const LOG_LIMIT = 10;
const HISTORY_LIMIT = 50;

type DeleteWithChildrenStrategy = "cascade" | "promoteToRoot";

type Snapshot = Pick<AppState, "nodes">;

type Store = AppState & {
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;

  addDepartment: (parentId: string | null) => void;
  addPerson: (parentId: string | null) => void;
  deleteNode: (id: string, strategy?: DeleteWithChildrenStrategy) => void;
  rename: (id: string, name: string) => void;
  reparent: (nodeId: string, newParentId: string | null) => { ok: boolean; reason?: string };
  setSelected: (id: string | null) => void;
  setToast: (toast: AppState["toast"]) => void;

  undo: () => void;
  redo: () => void;
  reset: () => void;
  save: () => void;
  loadFromStorage: () => void;
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

export const useOrgStore = create<Store>((set, get) => ({
  nodes: seedData(),
  selectedId: null,
  log: [makeLog("reset", "初期データを読み込み")],
  toast: null,
  past: [],
  future: [],
  dirty: false,

  addDepartment: (parentId) => {
    const state = get();
    const id = uid("d");
    const newNode: OrgNode = {
      id,
      kind: "department",
      name: "新規部署",
      parentId,
      x: 0,
      y: 0,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: pushLog(state.log, makeLog("add", `部署「${newNode.name}」を追加`)),
      dirty: true,
    });
  },

  addPerson: (parentId) => {
    const state = get();
    const id = uid("p");
    const newNode: OrgNode = {
      id,
      kind: "person",
      name: "新規メンバー",
      parentId,
      x: 0,
      y: 0,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: pushLog(state.log, makeLog("add", `人員「${newNode.name}」を追加`)),
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

  reparent: (nodeId, newParentId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node) return { ok: false, reason: "対象ノードが見つかりません" };
    if (node.parentId === newParentId) return { ok: false, reason: "既に同じ親です" };
    if (wouldCreateCycle(state.nodes, nodeId, newParentId)) {
      return { ok: false, reason: "循環参照になるため移動できません" };
    }
    const newParent = newParentId ? state.nodes.find((n) => n.id === newParentId) : null;
    const detail = newParent
      ? `「${node.name}」を「${newParent.name}」配下に移動`
      : `「${node.name}」をルートへ移動`;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, parentId: newParentId } : n)),
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
      log: pushLog(state.log, makeLog("reset", "初期データへリセット")),
      dirty: true,
    });
  },

  save: () => {
    const state = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ nodes: state.nodes }));
      set({
        dirty: false,
        log: pushLog(state.log, makeLog("save", "localStorageに保存しました")),
        toast: { kind: "info", message: "保存しました" },
      });
    } catch (e) {
      set({ toast: { kind: "error", message: "保存に失敗しました" } });
    }
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
