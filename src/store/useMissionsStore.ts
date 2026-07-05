import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { PeriodCode, PeriodRow } from "../lib/supabase";
import { useAuthStore } from "./useAuthStore";
import {
  normalizeDefinition,
  answerKey,
  FALLBACK_PERIOD_CODES,
  type MissionTemplateRow,
  type MissionSheetRow,
  type MissionAnswerRow,
  type MissionStageEventRow,
  type MissionRespondent,
  type MissionStage,
  type AnswerValue,
} from "../lib/mission";

/**
 * P2: ミッションシートのストア。useProfilesStore / usePayrollStore の
 * 作法を踏襲 — 表示時 fetch（ポーリングなし）、書込みは
 * `.select().maybeSingle()` の 0 行で RLS サイレント拒否を検出してエラー化。
 *
 * シートの状態遷移（stage）はクライアントから直接 UPDATE できない —
 * 必ず SECURITY DEFINER RPC（mission_issue_sheets / mission_set_stage）
 * を経由する。employees / position_levels は既存ストアを再利用する。
 */

type SaveResult = { ok: boolean; reason?: string };

const RLS_DENIED_MSG =
  "保存がDBに反映されませんでした（権限が無い可能性があります）。";

function missingTableError(message: string | undefined): boolean {
  return !!message && /does not exist|could not find the table/i.test(message);
}

const MISSING_MSG =
  "ミッションシートのテーブルが見つかりません。supabase/migrations/0018_mission_sheets.sql を適用してください。";

/** period 表示ラベル: "5H1" → "5期上期"。periods が読めない時の代替。 */
export function periodLabel(code: PeriodCode, periods: PeriodRow[]): string {
  const row = periods.find((p) => p.code === code);
  if (row?.label) return row.label;
  const m = /^(\d+)H([12])$/.exec(code);
  if (m) return `${m[1]}期${m[2] === "1" ? "上期" : "下期"}`;
  return code;
}

function normalizeTemplate(row: MissionTemplateRow): MissionTemplateRow {
  return {
    ...row,
    definition: normalizeDefinition(row.definition),
    deadlines:
      row.deadlines && typeof row.deadlines === "object" ? row.deadlines : {},
  };
}

type MissionsState = {
  loaded: boolean;
  loading: boolean;
  error: string | null;

  templates: MissionTemplateRow[];
  /** RLS で見える分＝自分＋評価対象＋manage 時全員。 */
  sheets: MissionSheetRow[];
  answersBySheetId: Record<string, MissionAnswerRow[]>;
  eventsBySheetId: Record<string, MissionStageEventRow[]>;

  /** 期マスター。periods テーブルが読めない場合はフォールバック生成。 */
  periods: PeriodRow[];
  periodsLoaded: boolean;

  /** templates + sheets + periods をまとめてロード。 */
  refresh: () => Promise<void>;
  refreshTemplates: () => Promise<void>;
  refreshSheets: () => Promise<void>;
  refreshPeriods: () => Promise<void>;

  /** draft テンプレの upsert（id はクライアント生成 uuid 可）。 */
  saveTemplate: (
    row: Partial<MissionTemplateRow> & { id: string },
  ) => Promise<SaveResult>;
  publishTemplate: (id: string) => Promise<SaveResult>;
  archiveTemplate: (id: string) => Promise<SaveResult>;
  /** 行複製 → draft。複製先の期を指定する。 */
  duplicateTemplate: (
    id: string,
    newPeriod: PeriodCode,
  ) => Promise<SaveResult & { newId?: string }>;

  /** rpc('mission_issue_sheets') — 発行済みはサーバ側でスキップ（冪等）。 */
  issueSheets: (
    templateId: string,
    employeeNumbers: string[],
  ) => Promise<SaveResult & { created?: number }>;

  /** sheet + answers + stage_events（+ 未取得ならテンプレ）をロード。 */
  fetchSheetDetail: (sheetId: string) => Promise<SaveResult>;

  /** 設問 blur 時の自動保存（upsert・maybeSingle 検証）。 */
  saveAnswer: (
    sheetId: string,
    questionId: string,
    role: MissionRespondent,
    value: AnswerValue,
  ) => Promise<SaveResult>;

  /** rpc('mission_set_stage')。後退時は reason 必須（サーバ側でも強制）。 */
  setStage: (
    sheetId: string,
    toStage: MissionStage,
    reason?: string,
  ) => Promise<SaveResult>;
};

export const useMissionsStore = create<MissionsState>((set, get) => ({
  loaded: false,
  loading: false,
  error: null,
  templates: [],
  sheets: [],
  answersBySheetId: {},
  eventsBySheetId: {},
  periods: [],
  periodsLoaded: false,

  refresh: async () => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true });
      return;
    }
    set({ loading: true, error: null });
    const [tRes, sRes] = await Promise.all([
      supabase.from("mission_templates").select("*").order("created_at", { ascending: false }),
      supabase.from("mission_sheets").select("*"),
    ]);
    if (tRes.error || sRes.error) {
      const err = tRes.error ?? sRes.error;
      set({
        loading: false,
        loaded: true,
        error: missingTableError(err?.message)
          ? MISSING_MSG
          : err?.message ?? "ミッションデータの取得に失敗しました",
      });
      return;
    }
    set({
      loading: false,
      loaded: true,
      error: null,
      templates: ((tRes.data ?? []) as MissionTemplateRow[]).map(normalizeTemplate),
      sheets: (sRes.data ?? []) as MissionSheetRow[],
    });
    if (!get().periodsLoaded) await get().refreshPeriods();
  },

  refreshTemplates: async () => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from("mission_templates")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      set({ error: missingTableError(error.message) ? MISSING_MSG : error.message });
      return;
    }
    set({ templates: ((data ?? []) as MissionTemplateRow[]).map(normalizeTemplate) });
  },

  refreshSheets: async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("mission_sheets").select("*");
    if (error) {
      set({ error: missingTableError(error.message) ? MISSING_MSG : error.message });
      return;
    }
    set({ sheets: (data ?? []) as MissionSheetRow[] });
  },

  refreshPeriods: async () => {
    // periods テーブルの SELECT は payroll 管理者限定（0013 の RLS）なので、
    // mission manage 権限だけを持つユーザーには 0 行 / エラーになり得る。
    // その場合は PeriodCode の既知一覧からフォールバック生成する。
    let rows: PeriodRow[] = [];
    if (supabase) {
      const { data, error } = await supabase
        .from("periods")
        .select("*")
        .order("sort_order");
      if (!error && data && data.length > 0) rows = data as PeriodRow[];
    }
    if (rows.length === 0) {
      rows = FALLBACK_PERIOD_CODES.map((code, i) => ({
        code,
        label: periodLabel(code, []),
        start_date: "",
        end_date: "",
        monthly_salary_budget: null,
        is_closed: false,
        sort_order: i,
      }));
    }
    set({ periods: rows, periodsLoaded: true });
  },

  saveTemplate: async (row) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const sessionEmail = useAuthStore.getState().currentUser?.email ?? null;
    const { data, error } = await supabase
      .from("mission_templates")
      .upsert({ ...row, updated_by_email: sessionEmail }, { onConflict: "id" })
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = normalizeTemplate(data as MissionTemplateRow);
    set((s) => ({
      templates: [saved, ...s.templates.filter((t) => t.id !== saved.id)],
    }));
    return { ok: true };
  },

  publishTemplate: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { data, error } = await supabase
      .from("mission_templates")
      .update({ status: "published" })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = normalizeTemplate(data as MissionTemplateRow);
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? saved : t)),
    }));
    return { ok: true };
  },

  archiveTemplate: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { data, error } = await supabase
      .from("mission_templates")
      .update({ status: "archived" })
      .eq("id", id)
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = normalizeTemplate(data as MissionTemplateRow);
    set((s) => ({
      templates: s.templates.map((t) => (t.id === id ? saved : t)),
    }));
    return { ok: true };
  },

  duplicateTemplate: async (id, newPeriod) => {
    const src = get().templates.find((t) => t.id === id);
    if (!src) return { ok: false, reason: "複製元テンプレートが見つかりません" };
    const newId = crypto.randomUUID();
    const res = await get().saveTemplate({
      id: newId,
      period: newPeriod,
      title: `${src.title}（複製）`,
      definition: src.definition,
      deadlines: src.deadlines,
      status: "draft",
      calc_version: src.calc_version,
    });
    return res.ok ? { ok: true, newId } : res;
  },

  issueSheets: async (templateId, employeeNumbers) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { data, error } = await supabase.rpc("mission_issue_sheets", {
      p_template_id: templateId,
      p_employee_numbers: employeeNumbers,
    });
    if (error) return { ok: false, reason: error.message };
    await get().refreshSheets();
    return { ok: true, created: typeof data === "number" ? data : undefined };
  },

  fetchSheetDetail: async (sheetId) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const [shRes, aRes, eRes] = await Promise.all([
      supabase.from("mission_sheets").select("*").eq("id", sheetId).maybeSingle(),
      supabase.from("mission_answers").select("*").eq("sheet_id", sheetId),
      supabase
        .from("mission_stage_events")
        .select("*")
        .eq("sheet_id", sheetId)
        .order("created_at", { ascending: true }),
    ]);
    if (shRes.error) {
      return {
        ok: false,
        reason: missingTableError(shRes.error.message)
          ? MISSING_MSG
          : shRes.error.message,
      };
    }
    if (!shRes.data) {
      // RLS 拒否 or 存在しない — どちらも「閲覧不可」として扱う
      return { ok: false, reason: "シートが見つからないか、閲覧権限がありません。" };
    }
    const sheet = shRes.data as MissionSheetRow;
    set((s) => ({
      sheets: [sheet, ...s.sheets.filter((x) => x.id !== sheet.id)],
      answersBySheetId: {
        ...s.answersBySheetId,
        [sheetId]: (aRes.data ?? []) as MissionAnswerRow[],
      },
      eventsBySheetId: {
        ...s.eventsBySheetId,
        [sheetId]: (eRes.data ?? []) as MissionStageEventRow[],
      },
    }));
    // 一覧未ロードで直接シートURLに来た場合に備え、テンプレを補完 fetch
    if (!get().templates.some((t) => t.id === sheet.template_id)) {
      const { data: tData } = await supabase
        .from("mission_templates")
        .select("*")
        .eq("id", sheet.template_id)
        .maybeSingle();
      if (tData) {
        const tpl = normalizeTemplate(tData as MissionTemplateRow);
        set((s) => ({
          templates: [tpl, ...s.templates.filter((t) => t.id !== tpl.id)],
        }));
      }
    }
    return { ok: true };
  },

  saveAnswer: async (sheetId, questionId, role, value) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const sessionEmail = useAuthStore.getState().currentUser?.email;
    if (!sessionEmail) return { ok: false, reason: "サインインが必要です" };
    const { data, error } = await supabase
      .from("mission_answers")
      .upsert(
        {
          sheet_id: sheetId,
          question_id: questionId,
          respondent_role: role,
          value,
          author_email: sessionEmail,
        },
        { onConflict: "sheet_id,question_id,respondent_role" },
      )
      .select("*")
      .maybeSingle();
    if (error) return { ok: false, reason: error.message };
    // 0行 = RLS サイレント拒否（記入可能ステージ外・権限なし等）
    if (!data) return { ok: false, reason: RLS_DENIED_MSG };
    const saved = data as MissionAnswerRow;
    set((s) => {
      const rest = (s.answersBySheetId[sheetId] ?? []).filter(
        (a) =>
          answerKey(a.question_id, a.respondent_role) !==
          answerKey(questionId, role),
      );
      return {
        answersBySheetId: { ...s.answersBySheetId, [sheetId]: [...rest, saved] },
      };
    });
    return { ok: true };
  },

  setStage: async (sheetId, toStage, reason) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    const { error } = await supabase.rpc("mission_set_stage", {
      p_sheet_id: sheetId,
      p_to_stage: toStage,
      p_reason: reason ?? null,
    });
    if (error) return { ok: false, reason: error.message };
    // stage・遷移履歴・（ステージ連動の）記入可否が変わるので詳細を取り直す
    await get().fetchSheetDetail(sheetId);
    return { ok: true };
  },
}));

/** answers 配列から (question, role) の値を引く。 */
export function findAnswer(
  answers: MissionAnswerRow[] | undefined,
  questionId: string,
  role: MissionRespondent,
): MissionAnswerRow | null {
  return (
    answers?.find(
      (a) => a.question_id === questionId && a.respondent_role === role,
    ) ?? null
  );
}
