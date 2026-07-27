// パルスサーベイ Claude 要約 Edge Function（スライス6）。
//
// TalentHub は純クライアント SPA（サーバなし）のため、Anthropic 鍵を伴う処理だけ
// この Edge Function に隔離する（設計グリル決定⑥）。
//   1. 呼び出し元の JWT で pulse_can_manage_alert を検証（権限者のみ）
//   2. service_role で当該サイクルの集計＋コメントを取得（脱識別・氏名は送らない）
//   3. Anthropic Messages API で要約（テーマ/センチメント/懸念/推奨アクション）
//   4. service_role で pulse_summaries に upsert（1サイクル1件）
//
// 必要な secret: ANTHROPIC_API_KEY（`supabase secrets set` で投入）。
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定で注入される。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ANTHROPIC_MODEL = "claude-sonnet-5";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return json({ error: "missing authorization" }, 401);
  if (!ANTHROPIC_API_KEY) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

  let cycleId: string | null = null;
  try {
    const body = await req.json();
    cycleId = body?.cycle_id ?? null;
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  if (!cycleId) return json({ error: "cycle_id is required" }, 400);

  // ── 1. 権限検証（呼び出し元の JWT で pulse_can_manage_alert） ──
  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: canManage, error: permErr } = await asUser.rpc("pulse_can_manage_alert");
  if (permErr) return json({ error: "permission check failed: " + permErr.message }, 500);
  if (!canManage) return json({ error: "permission denied" }, 403);

  // ── 2. service_role で集計＋コメント取得（氏名は送らない＝脱識別） ──
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: cycle, error: cErr } = await admin
    .from("pulse_cycles")
    .select("id, period")
    .eq("id", cycleId)
    .single();
  if (cErr || !cycle) return json({ error: "cycle not found" }, 404);

  const { data: aggs } = await admin
    .from("pulse_monthly_aggregates")
    .select("dimension, dimension_key, metrics")
    .eq("period", cycle.period);

  const { data: responses } = await admin
    .from("pulse_responses")
    .select("comment, snap_department")
    .eq("cycle_id", cycleId);

  const comments = (responses ?? [])
    .filter((r: any) => r.comment && String(r.comment).trim() !== "")
    .map((r: any) => ({ department: r.snap_department ?? "不明", comment: String(r.comment).trim() }));
  const responseCount = (responses ?? []).length;

  const total = (aggs ?? []).find((a: any) => a.dimension === "total")?.metrics ?? {};
  const byDept = (aggs ?? [])
    .filter((a: any) => a.dimension === "department" && !a.metrics?.masked)
    .map((a: any) => ({ dept: a.dimension_key, avg: a.metrics?.avg_overall, n: a.metrics?.n }));

  // ── 3. Anthropic Messages API で要約 ──
  const context = {
    period: cycle.period,
    response_count: responseCount,
    response_rate: total?.response_rate ?? null,
    avg_overall: total?.avg_overall ?? null,
    by_category: total?.by_category ?? {},
    weather_dist: total?.weather_dist ?? {},
    by_department: byDept,
    comments: comments.map((c) => c.comment), // 氏名なし・本文のみ
  };

  const prompt = [
    "あなたは組織のコンディションを分析する人事アナリストです。",
    "以下は月次パルスサーベイ（従業員コンディション調査）の集計結果と自由記述コメントです。",
    "経営者向けに、簡潔で示唆に富む要約を日本語で作成してください。",
    "",
    "## 出力フォーマット（Markdown・見出しは以下に固定）",
    "### 全体傾向\n（1〜2文でコンディションの総括。スコアは5点満点=天気5換算）",
    "### 主要テーマ\n（コメントから見える論点を3〜5個、箇条書き。件数の偏りも触れる）",
    "### 懸念・リスク\n（早期対応が必要なサインを箇条書き。無ければ「特筆すべき懸念なし」）",
    "### 推奨アクション\n（次の一手を2〜3個、具体的に）",
    "",
    "注意: 個人を特定する表現は避け、脱識別された傾向として記述すること。",
    "",
    "## データ",
    "```json",
    JSON.stringify(context, null, 2),
    "```",
  ].join("\n");

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!aiRes.ok) {
    const errText = await aiRes.text();
    return json({ error: "anthropic error", detail: errText.slice(0, 500) }, 502);
  }
  const aiJson = await aiRes.json();
  const summary = (aiJson?.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("\n")
    .trim();

  if (!summary) return json({ error: "empty summary from model" }, 502);

  // ── 4. pulse_summaries に upsert（service_role） ──
  const { error: upErr } = await admin
    .from("pulse_summaries")
    .upsert(
      {
        cycle_id: cycleId,
        period: cycle.period,
        summary,
        model: ANTHROPIC_MODEL,
        meta: { comment_count: comments.length, response_count: responseCount },
      },
      { onConflict: "cycle_id" },
    );
  if (upErr) return json({ error: "save failed: " + upErr.message }, 500);

  return json({ ok: true, period: cycle.period, model: ANTHROPIC_MODEL, summary });
});
