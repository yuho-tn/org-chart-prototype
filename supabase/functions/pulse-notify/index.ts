// パルスサーベイ 配信 Edge Function（スライス7）。
//
// Slack DM ＋ メールのダブルリマインド（設計グリル決定⑦⑧）。
//   • broadcast（初回一斉）: 裕鵬 1クリック承認で手動起動（呼出元JWTで
//     pulse_can_manage_alert を検証）。在籍者全員へ送信。
//   • reminder（締切前リマインド）: pg_cron から x-cron-secret 付きで自動起動。
//     未回答者のみへ送信。
//   Slack DM 先は users.lookupByEmail で email から解決（slackUserId は保存不要）。
//   送信結果は pulse_notifications に記録（channel×status）。
//
// 必要な secret（`supabase secrets set`）:
//   SLACK_BOT_TOKEN   … Slack Bot（chat:write, users:read.email）。無ければ Slack skip
//   RESEND_API_KEY    … Resend。無ければ email skip
//   RESEND_FROM       … 送信元（例 "TalentHub <pulse@yourdomain>"）
//   PULSE_CRON_SECRET … reminder 自動起動の共有シークレット
//   PULSE_APP_URL     … 回答フォーム基底（既定 https://shosan-talent-hub.vercel.app）
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** 限定並列で配列を処理（Edge Function のタイムアウト対策）。 */
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "TalentHub <onboarding@resend.dev>";
  const CRON_SECRET = Deno.env.get("PULSE_CRON_SECRET");
  const APP_URL = Deno.env.get("PULSE_APP_URL") ?? "https://shosan-talent-hub.vercel.app";

  let cycleId: string | null = null;
  let mode: "broadcast" | "reminder" = "broadcast";
  try {
    const body = await req.json();
    cycleId = body?.cycle_id ?? null;
    if (body?.mode === "reminder") mode = "reminder";
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  if (!cycleId) return json({ error: "cycle_id is required" }, 400);

  // ── 認可: cron（x-cron-secret）か、権限者JWT（pulse_can_manage_alert） ──
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

  // 配信チャネルが1つも設定されていなければ、サイレントno-opにせず即エラーで
  // 呼び出し元（管理画面）に気づかせる（設計書 §2 no_channel_configured）。
  // ※認可チェックの後に置く＝未認可の呼び出し元へ設定状態を漏らさない。
  if (!SLACK_BOT_TOKEN && !RESEND_API_KEY) {
    return json(
      { error: "no_channel_configured", detail: "SLACK_BOT_TOKEN / RESEND_API_KEY のいずれも未設定です" },
      400,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: cycle, error: cErr } = await admin
    .from("pulse_cycles")
    .select("id, period, due_date, status")
    .eq("id", cycleId)
    .single();
  if (cErr || !cycle) return json({ error: "cycle not found" }, 404);
  if (cycle.status !== "sent") {
    return json({ error: `cycle is not open for answers (status=${cycle.status})` }, 409);
  }

  // ── 対象者: 在籍＋email 有り。reminder は未回答者のみ。 ──
  const { data: employees, error: eErr } = await admin
    .from("employees")
    .select("employee_number, display_name, full_name, email")
    .is("left_at", null);
  if (eErr) return json({ error: "employees fetch failed: " + eErr.message }, 500);

  let targets = (employees ?? []).filter((e: any) => e.email && String(e.email).includes("@"));

  if (mode === "reminder") {
    const { data: responded } = await admin
      .from("pulse_responses")
      .select("employee_number")
      .eq("cycle_id", cycleId);
    const done = new Set((responded ?? []).map((r: any) => r.employee_number));
    targets = targets.filter((e: any) => !done.has(e.employee_number));
  }

  const period = cycle.period;
  const due = cycle.due_date ? `（締切: ${cycle.due_date}）` : "";
  const link = `${APP_URL}/#/survey`;
  const nameOf = (e: any) => e.display_name ?? e.full_name ?? "";
  const title = mode === "reminder" ? "【リマインド】月次パルスサーベイのご回答のお願い" : "月次パルスサーベイのご回答のお願い";
  const text = (name: string) =>
    `${name}さん\n\n${period} の月次パルスサーベイにご回答ください${due}。\n所要3分・かんたんな選択式＋一言コメントです。\n\n▼回答はこちら（ログイン必須）\n${link}\n\n※このメッセージは TalentHub パルスサーベイから自動送信されています。`;

  // ── Slack DM（users.lookupByEmail → chat.postMessage） ──
  async function slackDM(email: string, msg: string): Promise<boolean> {
    if (!SLACK_BOT_TOKEN) return false;
    try {
      const lu = await fetch(
        "https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email),
        { headers: { Authorization: "Bearer " + SLACK_BOT_TOKEN } },
      ).then((r) => r.json());
      const uid = lu?.user?.id;
      if (!lu?.ok || !uid) return false;
      const post = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: "Bearer " + SLACK_BOT_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({ channel: uid, text: msg }),
      }).then((r) => r.json());
      return !!post?.ok;
    } catch {
      return false;
    }
  }

  // ── メール（Resend） ──
  async function sendEmail(email: string, subject: string, body: string): Promise<boolean> {
    if (!RESEND_API_KEY) return false;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + RESEND_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: RESEND_FROM,
          to: [email],
          subject,
          text: body,
        }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  const kind = mode === "reminder" ? "reminder" : "broadcast";
  const notifRows: any[] = [];
  const counts = { targets: targets.length, slack_ok: 0, slack_fail: 0, email_ok: 0, email_fail: 0 };

  await mapLimit(targets, 5, async (e: any) => {
    const msg = text(nameOf(e));
    const [slackOk, mailOk] = await Promise.all([
      slackDM(e.email, msg),
      sendEmail(e.email, title, msg),
    ]);
    if (SLACK_BOT_TOKEN) {
      notifRows.push({ cycle_id: cycleId, employee_number: e.employee_number, channel: "slack", kind, status: slackOk ? "sent" : "failed" });
      slackOk ? counts.slack_ok++ : counts.slack_fail++;
    }
    if (RESEND_API_KEY) {
      notifRows.push({ cycle_id: cycleId, employee_number: e.employee_number, channel: "email", kind, status: mailOk ? "sent" : "failed" });
      mailOk ? counts.email_ok++ : counts.email_fail++;
    }
  });

  if (notifRows.length > 0) {
    // 記録（失敗しても配信自体は完了扱い）
    await admin.from("pulse_notifications").insert(notifRows);
  }

  return json({
    ok: true,
    mode,
    period,
    channels: { slack: !!SLACK_BOT_TOKEN, email: !!RESEND_API_KEY },
    counts,
  });
});
