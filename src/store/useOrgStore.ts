import { create } from "zustand";
import type { AppState, LogEntry, OrgNode, PersonRole, DeptCategory } from "../lib/types";
import { seedData } from "../lib/seed";
import { descendantsOf, wouldCreateCycle } from "../lib/layout";
import { applyMove, cloneSubtree } from "../lib/move";
import { STORAGE_KEYS } from "../lib/storageKeys";

const STORAGE_KEY = STORAGE_KEYS.draft;
// Bumped from 10 → 50 so the log can serve as a meaningful revision history,
// not just a recent-actions ribbon. Each entry carries the pre-state so the
// user can rewind to it (cf. spreadsheet-style version restore).
const LOG_LIMIT = 50;
const HISTORY_LIMIT = 50;

type DeleteWithChildrenStrategy = "cascade" | "promoteToRoot";

type Snapshot = Pick<AppState, "nodes">;

type Clipboard = { snapshot: OrgNode[]; rootId: string } | null;

type Store = AppState & {
  past: Snapshot[];
  future: Snapshot[];
  dirty: boolean;
  /** id of the server-side version currently displayed (null when seed/local-only) */
  currentVersionId: string | null;
  /** label shown next to the dirty/saved badge */
  currentVersionLabel: string | null;
  /** in-memory clipboard for Cmd+C / Cmd+V */
  clipboard: Clipboard;

  addDepartment: (
    parentId: string | null,
    opts?: { category?: DeptCategory; colorIndex?: number; placed?: boolean },
  ) => void;
  addPerson: (
    parentId: string | null,
    opts?: { roleLabel?: PersonRole; placed?: boolean },
  ) => void;
  /**
   * Create a person node from an employee master record. The new node lands
   * in the tray (isUnplaced=true) so the user can drag it into position.
   * Linked back to the master via employeeNumber so we can later compute
   * "unplaced employees" per version.
   */
  addPersonFromEmployee: (input: {
    employee_number: string;
    name: string;
    roleLabel?: PersonRole;
  }) => void;
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
  /** Deep-copy a subtree to the clipboard for later Cmd+V. */
  copyToClipboard: (id: string) => boolean;
  /** Paste clipboard contents into the tray as an unplaced subtree. */
  pasteFromClipboard: () => { ok: boolean; reason?: string };
  /** Deep-copy a subtree directly to a position (used by Option+Drag). */
  duplicateAtPosition: (
    sourceId: string,
    targetParentId: string | null,
    atIndex: number,
  ) => { ok: boolean; reason?: string; newRootId?: string };
  setSelected: (id: string | null) => void;
  setToast: (toast: AppState["toast"]) => void;

  undo: () => void;
  redo: () => void;
  reset: () => void;
  /** Start a fresh file: clears nodes to seed and detaches from any loaded
   *  version. Used by the "＋新規作成" flow. */
  newFile: () => void;
  /** Rewind nodes to the snapshot captured before the given log entry. */
  restoreToLog: (logId: string) => { ok: boolean; reason?: string };
  saveDraft: () => void;
  loadFromStorage: () => void;
  replaceNodes: (nodes: OrgNode[], meta?: { versionId?: string; versionLabel?: string }) => void;
  markClean: (meta?: { versionId?: string; versionLabel?: string }) => void;
};

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
}

function makeLog(
  action: LogEntry["action"],
  detail: string,
  snapshotBefore?: OrgNode[],
): LogEntry {
  return { id: uid("log"), ts: Date.now(), action, detail, snapshotBefore };
}

function pushLog(log: LogEntry[], entry: LogEntry): LogEntry[] {
  return [entry, ...log].slice(0, LOG_LIMIT);
}

function snapshot(state: Pick<AppState, "nodes">): Snapshot {
  return { nodes: state.nodes.map((n) => ({ ...n })) };
}

/**
 * Build a log entry that carries the pre-state. Convenience wrapper used by
 * every action that mutates `nodes` — keeps "snapshot-before" capture in one
 * place instead of repeated `state.nodes.map(...)` boilerplate at call sites.
 */
function logEntry(
  state: Pick<AppState, "nodes" | "log">,
  action: LogEntry["action"],
  detail: string,
): LogEntry[] {
  return pushLog(
    state.log,
    makeLog(action, detail, state.nodes.map((n) => ({ ...n }))),
  );
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
  clipboard: null,

  addDepartment: (parentId, opts) => {
    const state = get();
    const id = uid("d");
    // When `placed` is true, the new dept attaches directly under the given
    // parent (used by the in-place "+" button on each card). Otherwise it
    // lands in the tray, and parentId is just a hint for the default category.
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
    const placed = !!opts?.placed && parentId !== null;
    const newNode: OrgNode = {
      id,
      kind: "department",
      name: "新規部署",
      parentId: placed ? parentId : null,
      category: inferred,
      colorIndex,
      isUnplaced: !placed,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: logEntry(
        state,
        "add",
        placed
          ? `部署「${newNode.name}」（${inferred}）を「${hintParent?.name ?? ""}」配下に追加`
          : `部署「${newNode.name}」（${inferred}）を未配置で追加`,
      ),
      dirty: true,
      toast: placed
        ? null
        : { kind: "info", message: "未配置エリアに追加しました。ドラッグで配置先を指定してください" },
    });
  },

  addPerson: (parentId, opts) => {
    const state = get();
    const id = uid("p");
    // `placed` direct-adds the person to the named department; otherwise the
    // person is left in the tray for the user to drag into place.
    const resolvedParent =
      opts?.placed && parentId
        ? nearestDeptAncestor(state.nodes, parentId)
        : null;
    const placed = !!opts?.placed && resolvedParent !== null;
    const parentMeta = resolvedParent
      ? state.nodes.find((n) => n.id === resolvedParent)
      : null;
    const newNode: OrgNode = {
      id,
      kind: "person",
      name: "新規メンバー",
      parentId: placed ? resolvedParent : null,
      roleLabel: opts?.roleLabel ?? null,
      isUnplaced: !placed,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: logEntry(
        state,
        "add",
        placed
          ? `人員「${newNode.name}」を「${parentMeta?.name ?? ""}」に追加`
          : `人員「${newNode.name}」を未配置で追加`,
      ),
      dirty: true,
      toast: placed
        ? null
        : {
            kind: "info",
            message: "未配置エリアに追加しました。ドラッグで配置先の部署を指定してください",
          },
    });
  },

  addPersonFromEmployee: ({ employee_number, name, roleLabel }) => {
    const state = get();
    // Don't double-add if this employee is already in the chart for the
    // current version. The "unplaced employees" UI filters out placed ones,
    // but a defensive check here prevents accidental duplicates from any
    // other code path.
    const already = state.nodes.find(
      (n) => n.kind === "person" && n.employeeNumber === employee_number && !n.isUnplaced,
    );
    if (already) {
      set({
        toast: {
          kind: "info",
          message: `${name} は既に配置済みです`,
        },
      });
      return;
    }
    const id = uid("p");
    const newNode: OrgNode = {
      id,
      kind: "person",
      name,
      parentId: null,
      roleLabel: roleLabel ?? null,
      isUnplaced: true,
      employeeNumber: employee_number,
    };
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, newNode],
      selectedId: id,
      log: logEntry(state, "add", `${name}（${employee_number}）を未配置に追加`),
      dirty: true,
      toast: {
        kind: "info",
        message: `${name} を未配置に追加しました。ドラッグで配置してください`,
      },
    });
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
      log: logEntry(state, "add", `役員「${newNode.name}」（${role}）を未配置で追加`),
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
      log: logEntry(
        state,
        "role",
        `「${target.name}」を${isExecutive ? "役員" : "通常メンバー"}に変更`,
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
      log: logEntry(state, "delete", detail),
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
      log: logEntry(state, "rename", `「${target.name}」→「${name}」`),
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
      log: logEntry(state, "role", `「${target.name}」の役職を ${roleLabel ?? "メンバー"} に変更`),
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
      log: logEntry(state, "rename", `「${target.name}」の種別を ${category} に変更`),
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
      log: logEntry(state, "move", detail),
      dirty: true,
    });
    return { ok: true };
  },

  copyToClipboard: (id) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === id);
    if (!target) return false;
    const subtree = [target, ...descendantsOf(state.nodes, id)].map((n) => ({
      ...n,
    }));
    set({
      clipboard: { snapshot: subtree, rootId: id },
      log: logEntry(
        state,
        "add",
        `「${target.name}」をコピー（${subtree.length}件）`,
      ),
      toast: {
        kind: "info",
        message: `「${target.name}」をコピーしました（Cmd+Vで貼り付け）`,
      },
    });
    return true;
  },

  pasteFromClipboard: () => {
    const state = get();
    const cb = state.clipboard;
    if (!cb) {
      set({ toast: { kind: "error", message: "クリップボードが空です" } });
      return { ok: false, reason: "クリップボードが空です" };
    }
    const { clones, newRootId } = cloneSubtree(cb.snapshot, cb.rootId);
    if (clones.length === 0) return { ok: false, reason: "コピー対象が見つかりません" };
    // Mark only the root as unplaced; descendants follow naturally and are
    // hidden by the layout filter that walks ancestors.
    const stamped = clones.map((n) => {
      if (n.id === newRootId) {
        return {
          ...n,
          parentId: null,
          isUnplaced: true,
          name: `${n.name} (コピー)`,
        };
      }
      return { ...n, isUnplaced: false };
    });
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: [...state.nodes, ...stamped],
      selectedId: newRootId,
      log: logEntry(
        state,
        "add",
        `「${stamped[0].name}」を貼り付け（未配置に${stamped.length}件）`,
      ),
      toast: {
        kind: "info",
        message: "未配置エリアに貼り付けました。ドラッグで配置してください",
      },
      dirty: true,
    });
    return { ok: true };
  },

  duplicateAtPosition: (sourceId, targetParentId, atIndex) => {
    const state = get();
    const source = state.nodes.find((n) => n.id === sourceId);
    if (!source) return { ok: false, reason: "対象ノードが見つかりません" };
    if (source.kind === "person" && targetParentId) {
      const target = state.nodes.find((n) => n.id === targetParentId);
      if (!target || target.kind !== "department") {
        return { ok: false, reason: "人員は部署の中にのみ配置できます" };
      }
    }
    const { clones, newRootId } = cloneSubtree(state.nodes, sourceId);
    if (clones.length === 0) return { ok: false, reason: "コピーに失敗しました" };
    // The new root attaches to the target; descendants keep their (remapped)
    // internal parent links. All clones are placed (isUnplaced=false).
    const stamped = clones.map((n) =>
      n.id === newRootId
        ? { ...n, parentId: targetParentId, isUnplaced: false }
        : { ...n, isUnplaced: false },
    );
    let next = [...state.nodes, ...stamped];
    next = applyMove(next, newRootId, targetParentId, atIndex);
    const targetMeta = targetParentId
      ? state.nodes.find((n) => n.id === targetParentId)
      : null;
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: next,
      selectedId: newRootId,
      log: logEntry(
        state,
        "add",
        targetMeta
          ? `「${source.name}」を「${targetMeta.name}」配下に複製（${clones.length}件）`
          : `「${source.name}」をルートに複製（${clones.length}件）`,
      ),
      toast: {
        kind: "info",
        message: `${source.name} を複製しました`,
      },
      dirty: true,
    });
    return { ok: true, newRootId };
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
      log: logEntry(state, "reset", "初期データへリセット"),
      dirty: true,
    });
  },

  newFile: () => {
    const state = get();
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: seedData(),
      selectedId: null,
      currentVersionId: null,
      currentVersionLabel: null,
      log: logEntry(state, "reset", "新規ファイルを作成"),
      dirty: true,
      toast: {
        kind: "info",
        message: "新規ファイルを開きました。保存するとサーバに登録されます。",
      },
    });
  },

  restoreToLog: (logId) => {
    const state = get();
    const entry = state.log.find((e) => e.id === logId);
    if (!entry) return { ok: false, reason: "ログが見つかりません" };
    if (!entry.snapshotBefore) {
      return { ok: false, reason: "このログには復元用の状態が記録されていません" };
    }
    set({
      past: [...state.past, snapshot(state)].slice(-HISTORY_LIMIT),
      future: [],
      nodes: entry.snapshotBefore.map((n) => ({ ...n })),
      selectedId: null,
      log: logEntry(state, "restore", `「${entry.detail}」の直前へ復元`),
      dirty: true,
      toast: {
        kind: "info",
        message: `${entry.detail} の直前の状態に戻しました`,
      },
    });
    return { ok: true };
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
      log: logEntry(
        state,
        "reset",
        meta?.versionLabel
          ? `バージョン「${meta.versionLabel}」を読み込みました`
          : "ノードを置き換えました",
      ),
    });
  },

  markClean: (meta) => {
    const state = get();
    set({
      dirty: false,
      currentVersionId: meta?.versionId ?? state.currentVersionId,
      currentVersionLabel: meta?.versionLabel ?? state.currentVersionLabel,
      log: meta?.versionLabel
        ? logEntry(state, "save", `バージョン「${meta.versionLabel}」を保存`)
        : state.log,
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
