import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type {
  PulseQuestionSetRow,
  PulseQuestionRow,
  PulseCycleRow,
  PulseQuestionType,
} from "../lib/pulse";

/**
 * パルスサーベイ 設定（質問セット＋設問＋サイクル）管理ストア（#/pulse/admin）。
 * すべて admin の直書き（0021 の RLS=pulse_is_admin＋不可変ガード）。
 *   • 質問セット: draft→active→archived の一方向。draft のみ編集/削除可。
 *   • 設問: 親セットが draft のときのみ可変。
 *   • サイクル: scheduled→sent→closed の一方向。
 * 新 migration 不要（既存ガードで完結）。
 */

type Result = { ok: boolean; reason?: string };

function guardMessage(message: string | undefined): string {
  if (!message) return "操作に失敗しました";
  if (/does not exist|could not find the (table|function)/i.test(message)) {
    return "パルスの設定テーブルが見つかりません。migration 0021 を適用してください。";
  }
  return message;
}

type PulseAdminState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;
  busy: boolean;

  sets: PulseQuestionSetRow[];
  questionsBySet: Record<string, PulseQuestionRow[]>;
  cycles: PulseCycleRow[];

  load: () => Promise<void>;

  createSet: (name: string) => Promise<Result>;
  renameSet: (id: string, name: string) => Promise<Result>;
  activateSet: (id: string) => Promise<Result>;
  archiveSet: (id: string) => Promise<Result>;
  deleteSet: (id: string) => Promise<Result>;
  cloneSet: (id: string) => Promise<Result>;

  addQuestion: (
    setId: string,
    q: { label: string; category: string | null; type: PulseQuestionType },
  ) => Promise<Result>;
  updateQuestion: (id: string, patch: Partial<Pick<PulseQuestionRow, "label" | "category" | "type" | "is_active">>) => Promise<Result>;
  deleteQuestion: (id: string) => Promise<Result>;
  moveQuestion: (setId: string, id: string, dir: -1 | 1) => Promise<Result>;

  createCycle: (input: {
    period: string;
    question_set_id: string;
    send_date: string | null;
    due_date: string | null;
  }) => Promise<Result>;
  sendCycle: (id: string) => Promise<Result>;
  closeCycle: (id: string) => Promise<Result>;
  notifyCycle: (id: string, mode: "broadcast" | "reminder") => Promise<Result>;
};

export const usePulseAdminStore = create<PulseAdminState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  busy: false,
  sets: [],
  questionsBySet: {},
  cycles: [],

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const [setsRes, qRes, cyclesRes] = await Promise.all([
      supabase.from("pulse_question_sets").select("*").order("name").order("version", { ascending: false }),
      supabase.from("pulse_questions").select("*").order("sort_order", { ascending: true }),
      supabase.from("pulse_cycles").select("*").order("period", { ascending: false }),
    ]);

    if (setsRes.error) {
      set({ loading: false, loaded: true, error: guardMessage(setsRes.error.message) });
      return;
    }

    const sets = (setsRes.data ?? []) as PulseQuestionSetRow[];
    const questions = (qRes.data ?? []) as PulseQuestionRow[];
    const questionsBySet: Record<string, PulseQuestionRow[]> = {};
    for (const q of questions) {
      (questionsBySet[q.question_set_id] ??= []).push(q);
    }
    const cycles = (cyclesRes.data ?? []) as PulseCycleRow[];

    set({ loading: false, loaded: true, error: null, sets, questionsBySet, cycles });
  },

  createSet: async (name) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (!name.trim()) return { ok: false, reason: "セット名を入力してください" };
    set({ busy: true });
    const { error } = await supabase
      .from("pulse_question_sets")
      .insert({ name: name.trim(), version: 1, status: "draft" });
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  renameSet: async (id, name) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (!name.trim()) return { ok: false, reason: "セット名を入力してください" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_question_sets").update({ name: name.trim() }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  activateSet: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_question_sets").update({ status: "active" }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  archiveSet: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_question_sets").update({ status: "archived" }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  deleteSet: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_question_sets").delete().eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  cloneSet: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const src = get().sets.find((s) => s.id === id);
    if (!src) return { ok: false, reason: "元セットが見つかりません" };
    set({ busy: true });
    const { data: created, error: e1 } = await supabase
      .from("pulse_question_sets")
      .insert({ name: src.name, version: src.version + 1, status: "draft" })
      .select("id")
      .single();
    if (e1 || !created) {
      set({ busy: false });
      return { ok: false, reason: guardMessage(e1?.message) };
    }
    const srcQs = get().questionsBySet[id] ?? [];
    if (srcQs.length > 0) {
      const { error: e2 } = await supabase.from("pulse_questions").insert(
        srcQs.map((q) => ({
          question_set_id: created.id,
          sort_order: q.sort_order,
          label: q.label,
          category: q.category,
          type: q.type,
          is_active: q.is_active,
        })),
      );
      if (e2) {
        set({ busy: false });
        return { ok: false, reason: guardMessage(e2.message) };
      }
    }
    set({ busy: false });
    await get().load();
    return { ok: true };
  },

  addQuestion: async (setId, q) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (!q.label.trim()) return { ok: false, reason: "設問文を入力してください" };
    const existing = get().questionsBySet[setId] ?? [];
    const nextOrder = existing.reduce((m, x) => Math.max(m, x.sort_order), -1) + 1;
    set({ busy: true });
    const { error } = await supabase.from("pulse_questions").insert({
      question_set_id: setId,
      sort_order: nextOrder,
      label: q.label.trim(),
      category: q.category?.trim() || null,
      type: q.type,
      is_active: true,
    });
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  updateQuestion: async (id, patch) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_questions").update(patch).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  deleteQuestion: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_questions").delete().eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  moveQuestion: async (setId, id, dir) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const list = [...(get().questionsBySet[setId] ?? [])].sort((a, b) => a.sort_order - b.sort_order);
    const i = list.findIndex((q) => q.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return { ok: true };
    const a = list[i];
    const b = list[j];
    set({ busy: true });
    // sort_order を入れ替え（2件更新）。unique 制約は無いので直接スワップ可。
    const r1 = await supabase.from("pulse_questions").update({ sort_order: b.sort_order }).eq("id", a.id);
    const r2 = await supabase.from("pulse_questions").update({ sort_order: a.sort_order }).eq("id", b.id);
    set({ busy: false });
    if (r1.error || r2.error) return { ok: false, reason: guardMessage(r1.error?.message ?? r2.error?.message) };
    await get().load();
    return { ok: true };
  },

  createCycle: async (input) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (!/^\d{4}-\d{2}$/.test(input.period)) return { ok: false, reason: "対象月は YYYY-MM 形式で入力してください" };
    if (!input.question_set_id) return { ok: false, reason: "質問セットを選択してください" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_cycles").insert({
      period: input.period,
      question_set_id: input.question_set_id,
      send_date: input.send_date,
      due_date: input.due_date,
      status: "scheduled",
    });
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  sendCycle: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_cycles").update({ status: "sent" }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  closeCycle: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_cycles").update({ status: "closed" }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    await get().load();
    return { ok: true };
  },

  notifyCycle: async (id, mode) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { data, error } = await supabase.functions.invoke("pulse-notify", {
      body: { cycle_id: id, mode },
    });
    set({ busy: false });
    if (error) {
      return {
        ok: false,
        reason: "配信に失敗しました（Edge Function 未デプロイ、または Slack/メールの secret 未設定の可能性）",
      };
    }
    if (data?.error) return { ok: false, reason: String(data.error) };
    const c = data?.counts;
    const detail = c ? `対象${c.targets}名・Slack ${c.slack_ok}／メール ${c.email_ok}` : "";
    return { ok: true, reason: detail };
  },
}));
