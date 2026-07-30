import { create } from "zustand";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { usePulseCyclesStore } from "./usePulseCyclesStore";
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
 *
 * cycles は usePulseCyclesStore（共有・60秒キャッシュ）に委譲する。本storeは
 * pulse_cycles を直接書き換える（createCycle/sendCycle/closeCycle）ため、
 * 変更直後は invalidate() で共有キャッシュを無効化してから再読込する。
 */

type Result = { ok: boolean; reason?: string };

/** サイクル別の回答数/対象数（pulse_admin_cycle_stats・cycle_id をキーに持つ）。 */
export type PulseCycleStats = { responses: number; target: number };

/** pulse-notify の内訳（設計書 §6：トースト＋行内結果表示に使う）。 */
export type PulseNotifyDetail = {
  targets: number;
  slack_ok: number;
  slack_fail: number;
  email_ok: number;
  email_fail: number;
  channels: { slack: boolean; email: boolean };
};

/** notifyCycle の戻り値。UI 側でトースト文言・行内結果・no_channel_configured 案内を組み立てる。 */
export type NotifyResult = {
  ok: boolean;
  reason?: string;
  /** SLACK_BOT_TOKEN / RESEND_API_KEY が両方未設定（Edge Function 400）。 */
  noChannelConfigured?: boolean;
  detail?: PulseNotifyDetail;
};

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
  /** pulse_admin_cycle_stats() の結果。cycle_id → {responses, target}。取得失敗時は空のまま（非致命）。 */
  cycleStats: Record<string, PulseCycleStats>;

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
  notifyCycle: (id: string, mode: "broadcast" | "reminder") => Promise<NotifyResult>;
};

export const usePulseAdminStore = create<PulseAdminState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  busy: false,
  sets: [],
  questionsBySet: {},
  cycles: [],
  cycleStats: {},

  load: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, error: "Supabase未設定です" });
      return;
    }
    set({ loading: true, error: null });

    const [setsRes, qRes, , statsRes] = await Promise.all([
      supabase.from("pulse_question_sets").select("*").order("name").order("version", { ascending: false }),
      supabase.from("pulse_questions").select("*").order("sort_order", { ascending: true }),
      usePulseCyclesStore.getState().loadCycles(),
      supabase.rpc("pulse_admin_cycle_stats"),
    ]);

    if (setsRes.error) {
      set({ loading: false, loaded: true, error: guardMessage(setsRes.error.message) });
      return;
    }

    const cyclesState = usePulseCyclesStore.getState();
    if (cyclesState.error) {
      set({ loading: false, loaded: true, error: guardMessage(cyclesState.error) });
      return;
    }

    const sets = (setsRes.data ?? []) as PulseQuestionSetRow[];
    const questions = (qRes.data ?? []) as PulseQuestionRow[];
    const questionsBySet: Record<string, PulseQuestionRow[]> = {};
    for (const q of questions) {
      (questionsBySet[q.question_set_id] ??= []).push(q);
    }
    const cycles: PulseCycleRow[] = cyclesState.cycles;

    // pulse_admin_cycle_stats は admin/can_manage_alert 限定 RPC。権限エラー等は
    // 画面全体を止めず、進捗ミニバー非表示（cycleStats={}）に留める（非致命）。
    const cycleStats: Record<string, PulseCycleStats> = {};
    if (!statsRes.error && Array.isArray(statsRes.data)) {
      for (const row of statsRes.data as { cycle_id: string; responses: number; target: number }[]) {
        cycleStats[row.cycle_id] = { responses: row.responses, target: row.target };
      }
    }

    set({ loading: false, loaded: true, error: null, sets, questionsBySet, cycles, cycleStats });
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
    usePulseCyclesStore.getState().invalidate();
    await get().load();
    return { ok: true };
  },

  sendCycle: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_cycles").update({ status: "sent" }).eq("id", id);
    set({ busy: false });
    if (error) return { ok: false, reason: guardMessage(error.message) };
    usePulseCyclesStore.getState().invalidate();
    await get().load();
    return { ok: true };
  },

  closeCycle: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ busy: true });
    const { error } = await supabase.from("pulse_cycles").update({ status: "closed" }).eq("id", id);
    if (error) {
      set({ busy: false });
      return { ok: false, reason: guardMessage(error.message) };
    }
    // 締切時に最終集計を必ず回す（駆け込み回答を確定反映）。
    // 集計済みでも再実行して上書きする。失敗しても締切自体は成立させる。
    const cycle = usePulseCyclesStore.getState().cycles.find((c) => c.id === id);
    if (cycle) {
      await supabase.rpc("pulse_compute_aggregates", { p_period: cycle.period }).then(
        () => undefined,
        () => undefined,
      );
    }
    set({ busy: false });
    usePulseCyclesStore.getState().invalidate();
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
      // pulse-notify はエラー時すべて非2xxで返す（no_channel_configured=400 等）ため、
      // supabase-js は data=null・error=FunctionsHttpError になる。本文は
      // error.context（Response）から読み直す必要がある。
      if (error instanceof FunctionsHttpError) {
        try {
          const body = await error.context.json();
          if (body?.error === "no_channel_configured") {
            return {
              ok: false,
              noChannelConfigured: true,
              reason: body.detail ?? "SLACK_BOT_TOKEN / RESEND_API_KEY のいずれも未設定です",
            };
          }
          if (body?.error) return { ok: false, reason: String(body.error) };
        } catch {
          // 本文がJSONでない等はフォールバックへ
        }
      }
      return {
        ok: false,
        reason: "配信に失敗しました（Edge Function 未デプロイ、または Slack/メールの secret 未設定の可能性）",
      };
    }

    if (data?.error === "no_channel_configured") {
      return {
        ok: false,
        noChannelConfigured: true,
        reason: data.detail ?? "SLACK_BOT_TOKEN / RESEND_API_KEY のいずれも未設定です",
      };
    }
    if (data?.error) return { ok: false, reason: String(data.error) };

    const c = data?.counts;
    const detail: PulseNotifyDetail | undefined = c
      ? {
          targets: c.targets,
          slack_ok: c.slack_ok,
          slack_fail: c.slack_fail,
          email_ok: c.email_ok,
          email_fail: c.email_fail,
          channels: data?.channels ?? { slack: false, email: false },
        }
      : undefined;
    return { ok: true, detail };
  },
}));
