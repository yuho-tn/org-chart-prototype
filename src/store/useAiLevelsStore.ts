import { create } from "zustand";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import { fetchWithRetry } from "../lib/query";
import {
  currentLevelMap,
  type AiLevelGrantRow,
  type AiLevelKind,
  type CurrentAiLevel,
} from "../lib/aiLevels";

/**
 * AI活用レベル（#/ailevel）用ストア。
 * ai_level_grants（migration 0033）を全件ロードし、employee_number →
 * 現在レベル（max(level)）の Map をクライアント集計で持つ。
 * 読取りは RLS で authenticated 全員可（全社フルオープン）、書込みは
 * 管理者のみ（master / privileged_admin — RLS 側でも二重にガード）。
 *
 * migration 0033 未適用の環境ではテーブル不在エラーになるため、
 * missing フラグを立てて「認定データなし/未接続」の空状態で
 * グレースフルに描画させる（クラッシュ・無限スピナーにしない）。
 */

type Result = { ok: boolean; reason?: string };

export type BulkEntry = { employee_number: string; level: number };

export type BulkSummary = {
  total: number;
  inserted: number;
  /** 重複キー（同一 社員×レベル×種別×認定日）でスキップされた件数。 */
  skipped: number;
  errors: string[];
};

/**
 * migration 0033 未適用（ai_level_grants テーブル不在）の判定。
 * テーブル名まで一致させ、列不一致など他のスキーマエラーを「未適用」と
 * 誤報告しないよう限定する。
 *   - Postgres:  relation "public.ai_level_grants" does not exist
 *   - PostgREST: Could not find the table 'public.ai_level_grants' in the schema cache
 */
function isMissingTable(message: string | undefined | null): boolean {
  return (
    !!message &&
    /(relation|table)[^\n]*ai_level_grants[^\n]*(does not exist|schema cache)/i.test(
      message,
    )
  );
}

const MISSING_MSG =
  "AIレベル認定テーブルが見つかりません。supabase/migrations/0033_ai_levels.sql を SQL Editor で適用してください（それまでは全員未認定として表示されます）。";

type AiLevelsState = {
  grants: AiLevelGrantRow[];
  /** employee_number → 現在レベル（grants から導出・set 時に更新）。 */
  levelByEmployee: Map<string, CurrentAiLevel>;
  loaded: boolean;
  loading: boolean;
  /** migration 0033 未適用（テーブル不在）— 空状態として扱う。 */
  missing: boolean;
  error: string | null;
  saving: boolean;

  /** silent: 手元にデータがある時はスピナーを出さず裏で再検証。 */
  refresh: (opts?: { silent?: boolean }) => Promise<void>;
  /** 個別付与（管理者のみ・RLS でもガード）。 */
  addGrant: (input: {
    employee_number: string;
    level: number;
    kind: AiLevelKind;
    certified_at: string;
    note?: string;
  }) => Promise<Result>;
  /** 誤登録行の削除（管理者のみ）。 */
  removeGrant: (id: string) => Promise<Result>;
  /** 一括投入（初回仮認定のシート取込用）。 */
  bulkImport: (
    entries: BulkEntry[],
    opts: { kind: AiLevelKind; certified_at: string; note?: string },
  ) => Promise<BulkSummary>;
};

function withDerived(grants: AiLevelGrantRow[]) {
  return { grants, levelByEmployee: currentLevelMap(grants) };
}

export const useAiLevelsStore = create<AiLevelsState>((set, get) => ({
  grants: [],
  levelByEmployee: new Map(),
  loaded: false,
  loading: false,
  missing: false,
  error: null,
  saving: false,

  refresh: async (opts) => {
    if (!isSupabaseConfigured || !supabase) {
      set({ loaded: true, missing: true, error: null });
      return;
    }
    const sb = supabase;
    const silent = Boolean(opts?.silent) && get().loaded;
    if (!silent) set({ loading: true, error: null });
    try {
      // PostgREST は既定で 1000 行上限のため .range() ページングで全件取得
      // （1000件ずつ・上限なし。id 順で安定ソートし取り漏れ/重複を防ぐ）。
      const PAGE = 1000;
      const all: AiLevelGrantRow[] = [];
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await fetchWithRetry(() =>
          sb
            .from("ai_level_grants")
            .select("*")
            .order("id", { ascending: true })
            .range(from, from + PAGE - 1),
        );
        if (error) {
          if (isMissingTable(error.message)) {
            // 0033 未適用: 全員未認定の空状態としてグレースフルに描画。
            set({
              loading: false,
              loaded: true,
              missing: true,
              error: null,
              ...withDerived([]),
            });
            return;
          }
          set({
            loading: false,
            loaded: true,
            error: error.message,
            // silent 再検証の失敗では手元のデータを消さない
            ...(silent ? {} : withDerived([])),
          });
          return;
        }
        const page = (data ?? []) as AiLevelGrantRow[];
        all.push(...page);
        if (page.length < PAGE) break;
      }
      // 表示は新しい付与が先（作成日時降順）。
      all.sort((a, b) => b.created_at.localeCompare(a.created_at));
      set({
        loading: false,
        loaded: true,
        missing: false,
        error: null,
        ...withDerived(all),
      });
    } catch (e) {
      // タイムアウト／ネットワーク断（リトライ尽き）。silent 時はデータ温存。
      set({ loading: false, loaded: true, error: (e as Error).message });
    }
  },

  addGrant: async (input) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (get().missing) return { ok: false, reason: MISSING_MSG };
    if (!input.employee_number.trim()) {
      return { ok: false, reason: "社員番号は必須です" };
    }
    if (!Number.isInteger(input.level) || input.level < 1 || input.level > 7) {
      return { ok: false, reason: "レベルは1〜7で指定してください" };
    }
    if (!input.certified_at) {
      return { ok: false, reason: "認定日は必須です" };
    }
    set({ saving: true });
    const { error } = await supabase.from("ai_level_grants").insert({
      employee_number: input.employee_number.trim(),
      level: input.level,
      kind: input.kind,
      certified_at: input.certified_at,
      note: input.note?.trim() || null,
    });
    set({ saving: false });
    if (error) {
      return {
        ok: false,
        reason: isMissingTable(error.message) ? MISSING_MSG : error.message,
      };
    }
    await get().refresh({ silent: true });
    return { ok: true };
  },

  removeGrant: async (id) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    set({ saving: true });
    const { error } = await supabase.from("ai_level_grants").delete().eq("id", id);
    set({ saving: false });
    if (error) return { ok: false, reason: error.message };
    set((s) => withDerived(s.grants.filter((g) => g.id !== id)));
    return { ok: true };
  },

  bulkImport: async (entries, opts) => {
    const summary: BulkSummary = {
      total: entries.length,
      inserted: 0,
      skipped: 0,
      errors: [],
    };
    if (!supabase) {
      summary.errors.push("Supabase未設定です");
      return summary;
    }
    if (get().missing) {
      summary.errors.push(MISSING_MSG);
      return summary;
    }
    if (entries.length === 0) {
      summary.errors.push("投入対象の行がありません");
      return summary;
    }
    set({ saving: true });
    const payload = entries.map((e) => ({
      employee_number: e.employee_number,
      level: e.level,
      kind: opts.kind,
      certified_at: opts.certified_at,
      note: opts.note?.trim() || null,
    }));
    // 200件チャンクで投入（employees CSV importer と同方式）。
    // 同一キー（社員×レベル×種別×認定日・0033 unique index）は
    // ignoreDuplicates でスキップ＝同じシートの再貼り付けが冪等になる。
    const CHUNK = 200;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.slice(i, i + CHUNK);
      const { data, error } = await supabase
        .from("ai_level_grants")
        .upsert(slice, {
          onConflict: "employee_number,level,kind,certified_at",
          ignoreDuplicates: true,
        })
        .select("id");
      if (error) {
        summary.errors.push(`行 ${i + 1}〜${i + slice.length} で失敗: ${error.message}`);
        continue;
      }
      const insertedNow = (data ?? []).length;
      summary.inserted += insertedNow;
      summary.skipped += slice.length - insertedNow;
    }
    set({ saving: false });
    await get().refresh({ silent: true });
    return summary;
  },
}));
