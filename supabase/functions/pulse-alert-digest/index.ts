// パルスサーベイ アラート通知ダイジェスト Edge Function（P2・PULSE_V3_DESIGN.md §10-6）。
//
// 人事管理者へアラートを Slack DM で届ける。決定5準拠＝上長には一切通知しない
// （通知先は pulse_settings.alert_digest_recipients のみ。閲覧権限は pulse_can_manage_alert）。
//
//   POST { mode: "daily" | "immediate" | "preview", alert_ids?: string[] }
//
//   • daily     : ① pulse-comment-classify を {mode:"batch"} でHTTP起動（取りこぼしの
//                   追い付き・失敗しても続行し、結果を応答の classify に含める）
//                 ② 当月(JST) status='sent' の各サイクルへ pulse_evaluate_cycle_rules
//                   （preset_unanswered_3m 等のサイクル単位ルール）
//                 ③ pulse_alert_digest_batch() で未通知（open かつ notified_at is null）を取得
//                   → digest_enabled=false / alerts 0件 / recipients 0件 のいずれかなら
//                     送らずに { ok, sent:0, skipped } で終える
//                 ④ composeDailyDigest（_shared/alertDigest.ts）で本文を組む
//                 ⑤ recipients へ Slack DM（_shared/slack.ts・最大3並列）
//                 ⑥ 1人以上成功したら pulse_mark_alerts_notified(ids, 'digest')
//   • immediate : body.alert_ids（必須・非空配列）だけを pulse_alert_digest_batch(alert_ids)
//                 で取得。immediate_enabled=false なら送らず daily に回す（mark しない）。
//                 composeImmediate（「【即時】」冒頭固定）で DM → mark 'immediate'。
//   • preview   : 送信・mark を一切行わない。副作用のある①②（分類・サイクル判定）も
//                 実行しない。pulse_alert_digest_batch() を読んで daily と同じ組み立て
//                 （composeDailyDigest）で text を返すだけ＝「今送るとこうなる」の確認用。
//
// 認可:
//   daily/immediate = x-cron-secret（PULSE_CRON_SECRET）か JWT(pulse_can_manage_alert)。
//   preview         = JWT(pulse_can_manage_alert) のみ（cron 起動不可・pulse-notify の
//                     preview と同じ理由＝呼び出し本人のセッションを要する操作ではないが、
//                     設計上「人の目で確認してから使う」機能を cron に晒さない）。
//
// 必要な secret（新規なし・既存 pulse-notify / pulse-summary と共用）:
//   SLACK_BOT_TOKEN   … 無ければ daily/immediate は 400 no_channel_configured（preview は除外）
//   PULSE_CRON_SECRET … cron・pulse-comment-classify 呼び出し・daily/immediate 認可に共用
//   PULSE_APP_URL     … 本文末尾のリンク（既定 https://shosan-talent-hub.vercel.app）
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// verify_jwt=false（config.toml で固定・cron が x-cron-secret のみで呼ぶため）。

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type AlertDigestBatch, composeDailyDigest, composeImmediate } from "../_shared/alertDigest.ts";
import { slackDM } from "../_shared/slack.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Mode = "daily" | "immediate" | "preview";
const MODES: readonly Mode[] = ["daily", "immediate", "preview"];

const EMPTY_BATCH: AlertDigestBatch = { recipients: [], alerts: [], open_total: 0, by_state: {} };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** 限定並列で配列を処理（pulse-notify の mapLimit と同型）。 */
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

/** 今日の JST 暦月 "YYYY-MM"（日本にDST無しのため+9h固定オフセットでよい。pulse-notify jstDateStr と同型）。 */
function jstPeriodStr(d: Date): string {
  const shifted = new Date(d.getTime() + 9 * 3600 * 1000);
  return shifted.toISOString().slice(0, 7);
}

interface AuthEnv {
  SUPABASE_URL: string;
  ANON_KEY: string;
  CRON_SECRET: string | undefined;
}

type AuthResult = { ok: true } | { ok: false; status: number; body: Record<string, unknown> };

/** daily/immediate = cron secret か JWT。preview = JWT のみ（cron 起動不可）。 */
async function authorize(req: Request, mode: Mode, env: AuthEnv): Promise<AuthResult> {
  if (mode !== "preview") {
    const cronHeader = req.headers.get("x-cron-secret");
    if (env.CRON_SECRET && cronHeader === env.CRON_SECRET) return { ok: true };
  }
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader) return { ok: false, status: 401, body: { error: "missing authorization" } };
  const asUser = createClient(env.SUPABASE_URL, env.ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: canManage, error: permErr } = await asUser.rpc("pulse_can_manage_alert");
  if (permErr) return { ok: false, status: 500, body: { error: "permission check failed: " + permErr.message } };
  if (!canManage) return { ok: false, status: 403, body: { error: "permission denied" } };
  // JWT 経路は「人事」（admin または scope='all'）に限る。ダイジェスト本文は全社の
  // 実名＋対人由来＋コメント要約を含むため、上長（own_unit）に preview/手動送信を
  // 許すと決定1/5 の穴になる（独立レビュー 2026-09-21 指摘#3）。cron 経路は上で return 済み。
  const { data: scope, error: scopeErr } = await asUser.rpc("pulse_scope");
  if (scopeErr) return { ok: false, status: 500, body: { error: "scope check failed: " + scopeErr.message } };
  if (scope !== "all") return { ok: false, status: 403, body: { error: "permission denied (hr only)" } };
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
  const CRON_SECRET = Deno.env.get("PULSE_CRON_SECRET");
  const APP_URL = Deno.env.get("PULSE_APP_URL") ?? "https://shosan-talent-hub.vercel.app";

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const body: Record<string, unknown> =
    rawBody && typeof rawBody === "object" && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};

  const modeRaw = body.mode;
  if (typeof modeRaw !== "string" || !MODES.includes(modeRaw as Mode)) {
    return json({ error: "invalid_mode", detail: 'mode must be one of "daily" | "immediate" | "preview"' }, 400);
  }
  const mode = modeRaw as Mode;

  let alertIds: string[] | null = null;
  if (body.alert_ids !== undefined) {
    const arr = body.alert_ids;
    if (!Array.isArray(arr) || arr.length === 0 || arr.some((v) => typeof v !== "string" || v.trim() === "")) {
      return json({ error: "invalid_input", detail: "alert_ids must be a non-empty array of strings" }, 400);
    }
    alertIds = arr as string[];
  }

  // ── 認可 ──
  const auth = await authorize(req, mode, { SUPABASE_URL, ANON_KEY, CRON_SECRET });
  if (!auth.ok) return json(auth.body, auth.status);

  // preview は secrets 未投入でも動く（pulse-notify preview と同じ思想＝配信チャネル未設定
  // の間の確認手段として残す）。
  if (mode !== "preview" && !SLACK_BOT_TOKEN) {
    return json({ error: "no_channel_configured", detail: "SLACK_BOT_TOKEN が未設定です" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ══ preview: 送信・mark 一切なし。副作用のある分類/評価は実行せず、今の状態だけ見せる ══
  if (mode === "preview") {
    const { data: batchRaw, error: batchErr } = await admin.rpc("pulse_alert_digest_batch", {
      p_alert_ids: alertIds,
    });
    if (batchErr) return json({ error: "batch_failed", detail: batchErr.message }, 500);
    const batch = (batchRaw ?? EMPTY_BATCH) as AlertDigestBatch;
    const text = composeDailyDigest(batch, APP_URL);
    return json({
      ok: true,
      mode: "preview",
      text,
      alerts: batch.alerts?.length ?? 0,
      recipients: (batch.recipients ?? []).map((r) => r.email),
    });
  }

  // ══ immediate: 指定 alert_ids のみ対象。呼び出し元（pulse__request_immediate）は
  //     必ず具体的な id を渡してくる設計のため、未指定は入力エラーとして扱う ══
  if (mode === "immediate") {
    if (!alertIds) {
      return json({ error: "invalid_input", detail: "immediate mode requires alert_ids" }, 400);
    }

    const { data: batchRaw, error: batchErr } = await admin.rpc("pulse_alert_digest_batch", {
      p_alert_ids: alertIds,
    });
    if (batchErr) return json({ error: "batch_failed", detail: batchErr.message }, 500);
    const batch = (batchRaw ?? EMPTY_BATCH) as AlertDigestBatch;

    if (batch.immediate_enabled === false) {
      return json({ ok: true, mode: "immediate", sent: 0, skipped: "disabled" });
    }
    if ((batch.alerts?.length ?? 0) === 0) {
      return json({ ok: true, mode: "immediate", sent: 0, skipped: "no_alerts" });
    }
    if ((batch.recipients?.length ?? 0) === 0) {
      return json({ ok: true, mode: "immediate", sent: 0, skipped: "no_recipients" });
    }

    const text = composeImmediate(batch, APP_URL);
    const results = await mapLimit(batch.recipients, 3, (r) => slackDM(SLACK_BOT_TOKEN!, r.email, text));
    const sent = results.filter(Boolean).length;
    const failed = results.length - sent;

    let marked = false;
    if (sent > 0) {
      const { error: markErr } = await admin.rpc("pulse_mark_alerts_notified", {
        p_alert_ids: batch.alerts.map((a) => a.id),
        p_kind: "immediate",
      });
      if (markErr) {
        console.error("pulse-alert-digest: mark_alerts_notified(immediate) failed:", markErr.message);
      } else {
        marked = true;
      }
    }

    return json({
      ok: true,
      mode: "immediate",
      alerts: batch.alerts.length,
      recipients: batch.recipients.length,
      sent,
      failed,
      marked,
    });
  }

  // ══ daily ══
  // ① pulse-comment-classify を {mode:"batch"} でHTTP起動（取りこぼしの追い付き）。
  //    失敗しても daily 本体は続行する（分類の遅延は許容し、通知は止めない）。
  let classifyResult: unknown = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/pulse-comment-classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET ?? "" },
      body: JSON.stringify({ mode: "batch" }),
    });
    classifyResult = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(
        "pulse-alert-digest: pulse-comment-classify call failed:",
        res.status,
        JSON.stringify(classifyResult),
      );
    }
  } catch (e) {
    console.error("pulse-alert-digest: pulse-comment-classify call threw:", (e as Error).message);
    classifyResult = { ok: false, error: (e as Error).message };
  }

  // ② 直近3サイクル（sent/closed・period 降順）へ pulse_evaluate_cycle_rules
  //    （preset_unanswered_3m は「closed か due_date 経過」で初めて成立する。月末締切だと
  //    経過＝翌月なので「当月 period の sent サイクル」だけでは永久に選ばれない＝
  //    独立レビュー 2026-09-21 指摘#2。冪等なので複数サイクルへ毎日回してよい・失敗しても続行）。
  const { data: sentCycles, error: cyclesErr } = await admin
    .from("pulse_cycles")
    .select("id, period, status")
    .in("status", ["sent", "closed"])
    .order("period", { ascending: false })
    .limit(3);
  if (cyclesErr) {
    console.error("pulse-alert-digest: cycles fetch failed:", cyclesErr.message);
  } else {
    for (const c of (sentCycles ?? []) as { id: string }[]) {
      const { error: evalErr } = await admin.rpc("pulse_evaluate_cycle_rules", { p_cycle_id: c.id });
      if (evalErr) {
        console.error("pulse-alert-digest: pulse_evaluate_cycle_rules failed for", c.id, evalErr.message);
      }
    }
  }

  // ③ 未通知（open かつ notified_at is null）を取得。
  const { data: batchRaw, error: batchErr } = await admin.rpc("pulse_alert_digest_batch", { p_alert_ids: null });
  if (batchErr) return json({ error: "batch_failed", detail: batchErr.message, classify: classifyResult }, 500);
  const batch = (batchRaw ?? EMPTY_BATCH) as AlertDigestBatch;

  if (batch.digest_enabled === false) {
    return json({ ok: true, mode: "daily", sent: 0, skipped: "disabled", classify: classifyResult });
  }
  if ((batch.alerts?.length ?? 0) === 0) {
    return json({ ok: true, mode: "daily", sent: 0, skipped: "no_alerts", classify: classifyResult });
  }
  if ((batch.recipients?.length ?? 0) === 0) {
    return json({ ok: true, mode: "daily", sent: 0, skipped: "no_recipients", classify: classifyResult });
  }

  // ④ 本文を組む。
  const text = composeDailyDigest(batch, APP_URL);

  // ⑤ recipients へ Slack DM（最大3並列）。
  const results = await mapLimit(batch.recipients, 3, (r) => slackDM(SLACK_BOT_TOKEN!, r.email, text));
  const sent = results.filter(Boolean).length;
  const failed = results.length - sent;

  // ⑥ 1人以上成功したら通知済みにマーク。
  let marked = false;
  if (sent > 0) {
    const { error: markErr } = await admin.rpc("pulse_mark_alerts_notified", {
      p_alert_ids: batch.alerts.map((a) => a.id),
      p_kind: "digest",
    });
    if (markErr) {
      console.error("pulse-alert-digest: mark_alerts_notified(digest) failed:", markErr.message);
    } else {
      marked = true;
    }
  }

  return json({
    ok: true,
    mode: "daily",
    alerts: batch.alerts.length,
    recipients: batch.recipients.length,
    sent,
    failed,
    marked,
    classify: classifyResult,
  });
});
