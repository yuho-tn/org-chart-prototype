import { create } from "zustand";
import { supabase } from "../lib/supabase";
import type {
  AmountKey,
  AssignKey,
  Half,
  LaborAmountRow,
  LaborAssignmentRow,
  LaborDeptMapRow,
  LaborFrontTargetRow,
  LaborPersonRow,
  LaborTermRow,
  LaborTmRow,
  Slot,
  TermCode,
} from "../lib/laborCost";
import { amountKey, assignKey } from "../lib/laborCost";

/**
 * 人件費管理（#/labor）ストア。
 *
 * - 全テーブルを一括ロード（数千行・単一ユーザー前提なのでシンプルに）
 * - 金額セルの編集は楽観更新→800msデバウンスでバッチupsert
 * - undo/redo は編集バッチ単位（グリッドのペースト1回=1バッチ）
 * - RLSにより laborcost_admins 以外はデータが返らない。ページ側でも
 *   laborcost_can_access RPC でゲートする（二重防御）。
 */

type AmountPatch = { personId: string; term: TermCode; slot: Slot; amount: number };
type AssignPatch = {
  personId: string; term: TermCode; half: Half;
  dept?: string | null; kenmu_dept?: string | null; kenmu_rate?: number; tm?: string | null;
};

type UndoEntry = {
  label: string;
  amounts?: { before: AmountPatch[]; after: AmountPatch[] };
  assigns?: { before: LaborAssignmentRow[]; after: LaborAssignmentRow[] };
};

type SaveState = "idle" | "pending" | "saving" | "error";

type State = {
  loaded: boolean;
  loading: boolean;
  accessChecked: boolean;
  canAccess: boolean;
  error: string | null;
  saveState: SaveState;
  saveError: string | null;

  terms: LaborTermRow[];
  people: LaborPersonRow[];
  assignments: Record<AssignKey, LaborAssignmentRow>;
  amounts: Record<AmountKey, LaborAmountRow>;
  deptMap: LaborDeptMapRow[];
  tms: LaborTmRow[];
  frontTargets: LaborFrontTargetRow[];
  insuranceRate: number;

  undoStack: UndoEntry[];
  redoStack: UndoEntry[];

  checkAccess: () => Promise<void>;
  load: () => Promise<void>;

  /** 金額セルのバッチ編集（グリッドから）。undo履歴に積む。 */
  applyAmountEdits: (edits: AmountPatch[], label?: string) => void;
  /** 所属/兼務/TM の編集。undo履歴に積む。 */
  applyAssignEdits: (edits: AssignPatch[], label?: string) => void;

  undo: () => void;
  redo: () => void;

  addPerson: (name: string) => Promise<LaborPersonRow | null>;
  updatePerson: (id: string, patch: Partial<Pick<LaborPersonRow, "name" | "departed" | "employee_number" | "hired_at">>) => Promise<void>;

  setForecastFlag: (term: TermCode, half: Half, isForecast: boolean) => Promise<void>;
  updateFrontTarget: (term: TermCode, half: Half, div: string, value: number) => Promise<void>;
  updateInsuranceRate: (rate: number) => Promise<void>;

  flushNow: () => Promise<void>;
};

// ── 保存キュー（モジュールローカル） ─────────────────────────────────

let amountQueue = new Map<AmountKey, AmountPatch>();
let assignQueue = new Map<AssignKey, LaborAssignmentRow>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_MS = 800;

async function flushQueues(set: (p: Partial<State>) => void, get: () => State) {
  if (!supabase) return;
  if (amountQueue.size === 0 && assignQueue.size === 0) {
    set({ saveState: "idle" });
    return;
  }
  const amountRows = [...amountQueue.values()];
  const assignRows = [...assignQueue.values()];
  amountQueue = new Map();
  assignQueue = new Map();
  set({ saveState: "saving" });
  try {
    if (amountRows.length > 0) {
      const { amounts } = get();
      const payload = amountRows.map((p) => ({
        person_id: p.personId,
        term: p.term,
        slot: p.slot,
        amount: p.amount,
        is_forecast:
          amounts[amountKey(p.personId, p.term, p.slot)]?.is_forecast ?? false,
      }));
      const { error } = await supabase
        .from("labor_amounts")
        .upsert(payload, { onConflict: "person_id,term,slot" });
      if (error) throw error;
    }
    if (assignRows.length > 0) {
      const payload = assignRows.map((a) => ({
        person_id: a.person_id,
        term: a.term,
        half: a.half,
        dept: a.dept,
        kenmu_dept: a.kenmu_dept,
        kenmu_rate: a.kenmu_rate,
        tm: a.tm,
      }));
      const { error } = await supabase
        .from("labor_assignments")
        .upsert(payload, { onConflict: "person_id,term,half" });
      if (error) throw error;
    }
    set({
      saveState: amountQueue.size > 0 || assignQueue.size > 0 ? "pending" : "idle",
      saveError: null,
    });
  } catch (e) {
    set({ saveState: "error", saveError: e instanceof Error ? e.message : String(e) });
  }
}

function scheduleFlush(set: (p: Partial<State>) => void, get: () => State) {
  set({ saveState: "pending" });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueues(set, get);
  }, FLUSH_MS);
}

// ── 内部: 編集適用（undo記録なし） ──────────────────────────────────

function applyAmountsRaw(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
  edits: AmountPatch[],
) {
  set((s) => {
    const amounts = { ...s.amounts };
    for (const e of edits) {
      const key = amountKey(e.personId, e.term, e.slot);
      const prev = amounts[key];
      amounts[key] = {
        person_id: e.personId,
        term: e.term,
        slot: e.slot,
        amount: e.amount,
        is_forecast: prev?.is_forecast ?? false,
      };
      amountQueue.set(key, e);
    }
    return { amounts };
  });
  scheduleFlush(set as unknown as (p: Partial<State>) => void, get);
}

function applyAssignsRaw(
  set: (fn: (s: State) => Partial<State>) => void,
  get: () => State,
  rows: LaborAssignmentRow[],
) {
  set((s) => {
    const assignments = { ...s.assignments };
    for (const r of rows) {
      const key = assignKey(r.person_id, r.term, r.half);
      assignments[key] = r;
      assignQueue.set(key, r);
    }
    return { assignments };
  });
  scheduleFlush(set as unknown as (p: Partial<State>) => void, get);
}

export const useLaborCostStore = create<State>((set, get) => ({
  loaded: false,
  loading: false,
  accessChecked: false,
  canAccess: false,
  error: null,
  saveState: "idle",
  saveError: null,

  terms: [],
  people: [],
  assignments: {},
  amounts: {},
  deptMap: [],
  tms: [],
  frontTargets: [],
  insuranceRate: 0.17,

  undoStack: [],
  redoStack: [],

  checkAccess: async () => {
    if (!supabase) { set({ accessChecked: true, canAccess: false }); return; }
    const { data, error } = await supabase.rpc("laborcost_can_access");
    set({ accessChecked: true, canAccess: !error && data === true });
  },

  load: async () => {
    if (!supabase || get().loading) return;
    set({ loading: true, error: null });
    try {
      // labor_amounts / labor_assignments は PostgREST の1リクエスト上限
      // （既定1000行）を超えうるため range でページングして全件取得する。
      const fetchAll = async <T,>(
        table: string,
        orderCols: string[],
      ): Promise<{ data: T[]; error: unknown }> => {
        const PAGE = 1000;
        const all: T[] = [];
        for (let from = 0; ; from += PAGE) {
          let q = supabase!.from(table).select("*");
          for (const c of orderCols) q = q.order(c);
          const { data, error } = await q.range(from, from + PAGE - 1);
          if (error) return { data: all, error };
          all.push(...((data ?? []) as T[]));
          if (!data || data.length < PAGE) break;
        }
        return { data: all, error: null };
      };

      const [terms, people, assigns, amounts, deptMap, tms, targets, settings] =
        await Promise.all([
          supabase.from("labor_terms").select("*").order("sort_order"),
          supabase.from("labor_people").select("*").order("sort_order"),
          fetchAll<LaborAssignmentRow>("labor_assignments", ["person_id", "term", "half"]),
          fetchAll<LaborAmountRow>("labor_amounts", ["person_id", "term", "slot"]),
          supabase.from("labor_dept_map").select("*"),
          supabase.from("labor_tms").select("*").order("sort_order"),
          supabase.from("labor_front_targets").select("*"),
          supabase.from("labor_settings").select("*"),
        ]);
      const firstErr =
        terms.error || people.error || assigns.error || amounts.error ||
        deptMap.error || tms.error || targets.error || settings.error;
      if (firstErr) throw firstErr;

      const assignments: Record<AssignKey, LaborAssignmentRow> = {};
      for (const a of (assigns.data ?? []) as LaborAssignmentRow[]) {
        assignments[assignKey(a.person_id, a.term, a.half)] = {
          ...a,
          kenmu_rate: Number(a.kenmu_rate ?? 0),
        };
      }
      const amountsRec: Record<AmountKey, LaborAmountRow> = {};
      for (const a of (amounts.data ?? []) as LaborAmountRow[]) {
        amountsRec[amountKey(a.person_id, a.term, a.slot)] = {
          ...a,
          amount: Number(a.amount ?? 0),
        };
      }
      const settingsRows = (settings.data ?? []) as { key: string; value: unknown }[];
      const ins = settingsRows.find((r) => r.key === "insurance_rate");

      set({
        loaded: true,
        loading: false,
        terms: (terms.data ?? []) as LaborTermRow[],
        people: (people.data ?? []) as LaborPersonRow[],
        assignments,
        amounts: amountsRec,
        deptMap: (deptMap.data ?? []) as LaborDeptMapRow[],
        tms: (tms.data ?? []) as LaborTmRow[],
        frontTargets: ((targets.data ?? []) as LaborFrontTargetRow[]).map((t) => ({
          ...t,
          sales_target: Number(t.sales_target),
        })),
        insuranceRate: ins ? Number(ins.value) : 0.17,
      });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  applyAmountEdits: (edits, label = "編集") => {
    if (edits.length === 0) return;
    const { amounts } = get();
    const before: AmountPatch[] = edits.map((e) => ({
      personId: e.personId,
      term: e.term,
      slot: e.slot,
      amount: amounts[amountKey(e.personId, e.term, e.slot)]?.amount ?? 0,
    }));
    applyAmountsRaw(set as never, get, edits);
    set((s) => ({
      undoStack: [...s.undoStack.slice(-49), { label, amounts: { before, after: edits } }],
      redoStack: [],
    }));
  },

  applyAssignEdits: (edits, label = "所属編集") => {
    if (edits.length === 0) return;
    const { assignments } = get();
    const beforeRows: LaborAssignmentRow[] = [];
    const afterRows: LaborAssignmentRow[] = [];
    for (const e of edits) {
      const key = assignKey(e.personId, e.term, e.half);
      const prev: LaborAssignmentRow =
        assignments[key] ?? {
          person_id: e.personId, term: e.term, half: e.half,
          dept: null, kenmu_dept: null, kenmu_rate: 0, tm: null,
        };
      beforeRows.push(prev);
      afterRows.push({
        ...prev,
        dept: e.dept !== undefined ? e.dept : prev.dept,
        kenmu_dept: e.kenmu_dept !== undefined ? e.kenmu_dept : prev.kenmu_dept,
        kenmu_rate: e.kenmu_rate !== undefined ? e.kenmu_rate : prev.kenmu_rate,
        tm: e.tm !== undefined ? e.tm : prev.tm,
      });
    }
    applyAssignsRaw(set as never, get, afterRows);
    set((s) => ({
      undoStack: [...s.undoStack.slice(-49), { label, assigns: { before: beforeRows, after: afterRows } }],
      redoStack: [],
    }));
  },

  undo: () => {
    const { undoStack } = get();
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    if (entry.amounts) applyAmountsRaw(set as never, get, entry.amounts.before);
    if (entry.assigns) applyAssignsRaw(set as never, get, entry.assigns.before);
    set((s) => ({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, entry],
    }));
  },

  redo: () => {
    const { redoStack } = get();
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    if (entry.amounts) applyAmountsRaw(set as never, get, entry.amounts.after);
    if (entry.assigns) applyAssignsRaw(set as never, get, entry.assigns.after);
    set((s) => ({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, entry],
    }));
  },

  addPerson: async (name) => {
    if (!supabase) return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    const maxSort = Math.max(0, ...get().people.map((p) => p.sort_order));
    const { data, error } = await supabase
      .from("labor_people")
      .insert({ name: trimmed, sort_order: maxSort + 10 })
      .select()
      .single();
    if (error || !data) {
      set({ saveState: "error", saveError: error?.message ?? "追加に失敗" });
      return null;
    }
    const row = data as LaborPersonRow;
    set((s) => ({ people: [...s.people, row] }));
    return row;
  },

  updatePerson: async (id, patch) => {
    if (!supabase) return;
    set((s) => ({
      people: s.people.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
    const { error } = await supabase.from("labor_people").update(patch).eq("id", id);
    if (error) set({ saveState: "error", saveError: error.message });
  },

  setForecastFlag: async (term, half, isForecast) => {
    if (!supabase) return;
    const slots =
      half === "H1" ? ["7", "8", "9", "10", "11", "12", "BS"] : ["1", "2", "3", "4", "5", "6", "BW"];
    set((s) => {
      const amounts = { ...s.amounts };
      for (const key of Object.keys(amounts) as AmountKey[]) {
        const a = amounts[key];
        if (a.term === term && slots.includes(a.slot)) {
          amounts[key] = { ...a, is_forecast: isForecast };
        }
      }
      return { amounts };
    });
    const { error } = await supabase
      .from("labor_amounts")
      .update({ is_forecast: isForecast })
      .eq("term", term)
      .in("slot", slots);
    if (error) set({ saveState: "error", saveError: error.message });
  },

  updateFrontTarget: async (term, half, div, value) => {
    if (!supabase) return;
    set((s) => ({
      frontTargets: s.frontTargets.map((t) =>
        t.term === term && t.half === half && t.div === div
          ? { ...t, sales_target: value }
          : t,
      ),
    }));
    const { error } = await supabase
      .from("labor_front_targets")
      .upsert(
        { term, half, div, sales_target: value },
        { onConflict: "term,half,div" },
      );
    if (error) set({ saveState: "error", saveError: error.message });
  },

  updateInsuranceRate: async (rate) => {
    if (!supabase) return;
    set({ insuranceRate: rate });
    const { error } = await supabase
      .from("labor_settings")
      .upsert({ key: "insurance_rate", value: rate }, { onConflict: "key" });
    if (error) set({ saveState: "error", saveError: error.message });
  },

  flushNow: async () => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    await flushQueues(set as unknown as (p: Partial<State>) => void, get);
  },
}));
