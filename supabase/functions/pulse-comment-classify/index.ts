// パルスサーベイ 自由記述コメント分類 Edge Function（P2・PULSE_V3_DESIGN.md §10-4・§10-6）。
//
//   POST { response_id: string } | { mode: "batch", limit?: number }
//
//   手順:
//     1. 認可: x-cron-secret（PULSE_CRON_SECRET）か JWT(pulse_can_manage_alert)。
//     2. ANTHROPIC_API_KEY 未設定 → 500 { error: "anthropic_not_configured" }。
//     3. service_role で rpc('pulse_pending_classifications', { p_limit }) を呼ぶ
//        （氏名・社員番号・部署は返らない＝n<5 作法・識別子を送らない §10-4）。
//          - mode:"batch"      … 返ってきた行をそのまま対象にする（最大 limit 件）。
//          - response_id 指定  … 返ってきた行を response_id で絞る。結果に含まれない
//                                （＝分類済みで comment_hash が変わっていない）場合は
//                                { ok:true, classified:0, ... } を返して終える。
//     4. 対象を最大3並列で処理: 本文＋天気4値＋eNPSのみを Claude(claude-sonnet-5) に渡し、
//        JSON のみを出力させる（コードフェンス付きでも剥がす）→ normalizeClassification で
//        11分類の固定値に丸める → rpc('pulse_apply_classification', {...}) で保存
//        （このRPC内部で本人×当サイクルの再判定・即時アラートの生成まで行う）。
//     5. Claude 呼び出し・応答パース・RPC 適用のいずれかが失敗した対象はスキップして続行する
//        （1件の異常でバッチ全体を失敗させない。件数は errors に集計）。
//
//   応答: { ok:true, classified:n, alerts_upserted:n, immediate:n, errors:n }
//   （§10-6 の本文は classified/alerts_upserted/immediate の3値のみ触れているが、
//    失敗件数の可視化のため errors も付与する＝実行後にCEOへ報告する契約差分）。
//
// 必要な secret: 新規なし。既存の ANTHROPIC_API_KEY（pulse-summary と共用）・
//   PULSE_CRON_SECRET（pulse-notify と共用）を再利用する。
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// verify_jwt=false（config.toml で固定・cron が x-cron-secret のみで呼ぶため）。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { COMMENT_CATEGORIES, normalizeClassification } from "../_shared/alertDigest.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";
const DEFAULT_BATCH_LIMIT = 50;
// response_id 単発指定時、対象がバックログの後方に埋もれていても拾えるよう広めに取る
// （pulse_pending_classifications は p_limit 件だけを返すため）。
const SINGLE_LOOKUP_LIMIT = 200;
const MAX_LIMIT = 200;
const MAX_CONCURRENCY = 3;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** 限定並列で配列を処理（pulse-notify の mapLimit と同型。Edge Function のタイムアウト対策）。 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

interface PendingRow {
  response_id: string;
  comment: string;
  weather: unknown;
  nps: number | null;
}

/** モデル出力がコードフェンス付きでも剥がして JSON.parse する。 */
function parseModelJson(text: string): unknown {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(s);
  if (fence) s = fence[1].trim();
  return JSON.parse(s);
}

function buildPrompt(row: PendingRow): string {
  return [
    "あなたは従業員アンケートの自由記述コメントを分類する人事アナリストです。",
    "以下は月次パルスサーベイの自由記述コメントと、同時に回答された天気4項目・eNPSです。",
    "このコメントを分類し、JSON のみを出力してください（説明文・前置き・コードフェンスは付けない）。",
    "",
    "## 分類カテゴリ（固定11種・該当する部分集合を1〜3件・最も強く該当するものを primary に）",
    COMMENT_CATEGORIES.join("、"),
    "",
    "## 重大度（severity）の目安",
    "high: SOS・体調不安など早急な対応が要る強いシグナル",
    "mid : 継続的なフォローが要る懸念（人間関係・評価・組織課題 等）",
    "low : 通常の意見・要望・キャリア・プライベート・総務・分類困難 等",
    "",
    "## 出力フォーマット（JSONのみ・キーはこの4つ）",
    '{"categories":["…"],"primary":"…","severity":"low|mid|high","summary":"60字以内の日本語1行"}',
    "",
    "## データ（本人を特定する情報は含まれていません）",
    "```json",
    JSON.stringify({ comment: row.comment, weather: row.weather ?? null, enps: row.nps ?? null }, null, 2),
    "```",
  ].join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const CRON_SECRET = Deno.env.get("PULSE_CRON_SECRET");
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const body: Record<string, unknown> =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};

  const singleResponseId = typeof body.response_id === "string" && body.response_id.trim() !== ""
    ? body.response_id
    : null;
  const isBatchMode = body.mode === "batch";
  if (!singleResponseId && !isBatchMode) {
    return json(
      { error: "invalid_input", detail: 'response_id または mode:"batch" のいずれかが必要です' },
      400,
    );
  }

  // ── 認可: x-cron-secret か JWT(pulse_can_manage_alert)（pulse-notify と同型） ──
  const cronHeader = req.headers.get("x-cron-secret");
  const isCron = !!CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isCron) {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "missing authorization" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canManage, error: permErr } = await asUser.rpc("pulse_can_manage_alert");
    if (permErr) return json({ error: "permission check failed: " + permErr.message }, 500);
    if (!canManage) return json({ error: "permission denied" }, 403);
  }

  if (!ANTHROPIC_API_KEY) return json({ error: "anthropic_not_configured" }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── 対象取得: pulse_pending_classifications（氏名・社員番号・部署は返らない） ──
  let limit: number;
  if (singleResponseId) {
    limit = SINGLE_LOOKUP_LIMIT;
  } else {
    const raw = body.limit;
    const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_BATCH_LIMIT;
    limit = Math.min(Math.max(n, 1), MAX_LIMIT);
  }

  const { data: pendingRaw, error: pendErr } = await admin.rpc("pulse_pending_classifications", {
    p_limit: limit,
  });
  if (pendErr) return json({ error: "pending_lookup_failed", detail: pendErr.message }, 500);
  const pending = (pendingRaw ?? []) as PendingRow[];

  const targets = singleResponseId ? pending.filter((r) => r.response_id === singleResponseId) : pending;

  if (targets.length === 0) {
    return json({ ok: true, classified: 0, alerts_upserted: 0, immediate: 0, errors: 0 });
  }

  let classified = 0;
  let alertsUpserted = 0;
  let immediate = 0;
  let errors = 0;

  await mapLimit(targets, MAX_CONCURRENCY, async (row) => {
    try {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: ANTHROPIC_MODEL,
          max_tokens: 300,
          messages: [{ role: "user", content: buildPrompt(row) }],
        }),
      });
      if (!aiRes.ok) {
        const errText = await aiRes.text().catch(() => "");
        console.error(
          "pulse-comment-classify: anthropic error for",
          row.response_id,
          aiRes.status,
          errText.slice(0, 300),
        );
        errors++;
        return;
      }

      const aiJson = await aiRes.json();
      const text = (aiJson?.content ?? [])
        .filter((b: { type?: string }) => b?.type === "text")
        .map((b: { text?: string }) => b?.text ?? "")
        .join("")
        .trim();

      let parsed: unknown = null;
      try {
        parsed = parseModelJson(text);
      } catch {
        console.error("pulse-comment-classify: unparseable model output for", row.response_id, text.slice(0, 200));
      }
      // parsed が null/不正でも normalizeClassification は例外を投げず「分類困難」に丸める。
      const norm = normalizeClassification(parsed);

      const { data: applyResult, error: applyErr } = await admin.rpc("pulse_apply_classification", {
        p_response_id: row.response_id,
        p_categories: norm.categories,
        p_primary: norm.primary,
        p_severity: norm.severity,
        p_summary: norm.summary,
        p_model: ANTHROPIC_MODEL,
      });
      if (applyErr) {
        console.error("pulse-comment-classify: apply failed for", row.response_id, applyErr.message);
        errors++;
        return;
      }

      classified++;
      const ar = (applyResult ?? {}) as { alerts_upserted?: number; immediate_alert_ids?: string[] };
      alertsUpserted += typeof ar.alerts_upserted === "number" ? ar.alerts_upserted : 0;
      immediate += Array.isArray(ar.immediate_alert_ids) ? ar.immediate_alert_ids.length : 0;
    } catch (e) {
      console.error("pulse-comment-classify: unexpected error for", row.response_id, (e as Error).message);
      errors++;
    }
  });

  return json({ ok: true, classified, alerts_upserted: alertsUpserted, immediate, errors });
});
