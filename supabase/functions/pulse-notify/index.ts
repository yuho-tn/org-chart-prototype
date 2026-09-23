// パルスサーベイ 配信 Edge Function（v3 P1・本人専用トークンURL対応）。
//
// Slack DM ＋ メールのダブルリマインド。
//   • broadcast（初回一斉）: 裕鵬 1クリック承認で手動起動（呼出元JWTで
//     pulse_can_manage_alert を検証）。対象者全員へ送信。同一cycle・同一
//     channelで送信済み（status='sent'）の人はそのチャネルをスキップする
//     （再実行が安全＝冪等）。
//   • reminder（締切前リマインド）: pg_cron から x-cron-secret 付きで自動起動、
//     または権限者JWTで手動起動。未回答の対象者のみへ送信。
//     pulse_settings.reminder_max_count 回に達した人・JST同日に送信済みの人
//     はスキップする。reminder_no は本人×サイクルの通し番号（slack/email
//     どちらのチャネルでも同一ラウンドは同じ reminder_no で記録する）。
//   • preview（新設・JWTのみ・送信しない）: 対象人数・文面（broadcast/
//     reminder/件名）・呼び出し本人の専用URL（本人が対象者の場合のみ）を
//     返す。secrets（SLACK_BOT_TOKEN/RESEND_API_KEY）未投入でも動く＝
//     配信チャネル未設定の間の検証手段。他人のURLは絶対に返さない。
//
//   対象者 = pulse_target_employee_numbers()（雇用形態＋個別除外）
//            ∩ 在籍（left_at is null）∩ email あり。
//   本人専用URL = {APP_URL}/#/survey?t=<token>
//            token = signPulseToken({cycleId, employeeNumber, exp})
//            exp   = expForCycle(cycle)（_shared/pulseToken.ts）
//   文面 = pulse_settings のテンプレ（{name}{month}{period}{url}{due}{minutes}）。
//          未設定・空文字ならコード側の既定文にフォールバックする。
//   送信結果は pulse_notifications に記録（channel×status×reminder_no）。
//
// 必要な secret（`supabase secrets set`）:
//   SLACK_BOT_TOKEN   … Slack Bot（chat:write, users:read.email）。無ければ Slack skip
//   RESEND_API_KEY    … Resend。無ければ email skip
//   RESEND_FROM       … 送信元（例 "TalentHub <pulse@yourdomain>"）
//   PULSE_CRON_SECRET … reminder 自動起動の共有シークレット
//   PULSE_APP_URL     … 回答フォーム基底（既定 https://shosan-talent-hub.vercel.app）
//   PULSE_TOKEN_SECRET… 任意。本人専用URLトークンの署名鍵材料（無ければ
//                        SUPABASE_SERVICE_ROLE_KEY を使う。_shared/pulseToken.ts参照）
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { expForCycle, getDefaultKeyMaterial, signPulseToken } from "../_shared/pulseToken.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type NotifyMode = "broadcast" | "reminder" | "preview";

const DEFAULT_BROADCAST_TEMPLATE =
  "{name}さん、{month}分のパルスサーベイの回答をお願いします（所要{minutes}分）\n{url}\n締切：{due}まで。このURLはあなた専用です（転送しないでください）。";
const DEFAULT_REMINDER_TEMPLATE =
  "{name}さん、{month}分のパルスサーベイがまだ回答されていません（所要{minutes}分）\n{url}\n締切：{due}まで。";
const DEFAULT_EMAIL_SUBJECT_TEMPLATE = "【TalentHub】{month}分パルスサーベイのご回答のお願い";
const DEFAULT_REMINDER_MAX_COUNT = 4;
const DEFAULT_SURVEY_MINUTES = 1;

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

function nameOf(e: any): string {
  return e.display_name ?? e.full_name ?? "";
}

/** period "YYYY-MM" → "M月"（例: "2026-11" → "11月"）。 */
function monthLabelOf(period: string): string {
  const m = /^\d{4}-(\d{2})$/.exec(period);
  if (!m) return period;
  return `${Number(m[1])}月`;
}

/** due_date "YYYY-MM-DD" → "M/D"（先頭ゼロ無し）。無ければ「設定なし」。 */
function dueLabelOf(dueDate: string | null | undefined): string {
  if (!dueDate) return "設定なし";
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(dueDate);
  if (!m) return dueDate;
  return `${Number(m[1])}/${Number(m[2])}`;
}

/** {name}{month}{period}{url}{due}{minutes} を置換する（未知のプレースホルダは残す）。 */
function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key] : whole));
}

/** Date → JST暦日 "YYYY-MM-DD"（日本にDST無しのため+9h固定オフセットでよい）。 */
function jstDateStr(d: Date): string {
  const shifted = new Date(d.getTime() + 9 * 3600 * 1000);
  return shifted.toISOString().slice(0, 10);
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
  let mode: NotifyMode = "broadcast";
  try {
    const body = await req.json();
    cycleId = body?.cycle_id ?? null;
    if (body?.mode === "reminder") mode = "reminder";
    else if (body?.mode === "preview") mode = "preview";
  } catch {
    return json({ error: "invalid json body" }, 400);
  }
  if (!cycleId) return json({ error: "cycle_id is required" }, 400);

  // ── 認可 ──
  //   broadcast/reminder: cron（x-cron-secret）か、権限者JWT（pulse_can_manage_alert）
  //   preview           : 権限者JWTのみ（本人特定＝my_url解決に呼び出し本人の
  //                        セッションが要るため cron 経由は認めない）
  let callerEmployeeNumber: string | null = null;

  if (mode === "preview") {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "missing authorization" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canManage, error: permErr } = await asUser.rpc("pulse_can_manage_alert");
    if (permErr) return json({ error: "permission check failed: " + permErr.message }, 500);
    if (!canManage) return json({ error: "permission denied" }, 403);
    const { data: empNum } = await asUser.rpc("pulse_current_employee_number");
    callerEmployeeNumber = typeof empNum === "string" ? empNum : null;
  } else {
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
  }

  // 配信チャネルが1つも設定されていなければ、サイレントno-opにせず即エラーで
  // 呼び出し元（管理画面）に気づかせる（設計書 §2 no_channel_configured）。
  // ※認可チェックの後に置く＝未認可の呼び出し元へ設定状態を漏らさない。
  // preview は secrets 未投入でも動く（＝これが secrets 投入前の検証手段）ので対象外。
  if (mode !== "preview" && !SLACK_BOT_TOKEN && !RESEND_API_KEY) {
    return json(
      { error: "no_channel_configured", detail: "SLACK_BOT_TOKEN / RESEND_API_KEY のいずれも未設定です" },
      400,
    );
  }

  // 本人専用URLの署名鍵（PULSE_TOKEN_SECRET）が無ければ、どのモードでも URL を作れない。
  // no_channel_configured と同じく、認可の後で明示エラーにする（Runbook ①-1-6）。
  try {
    getDefaultKeyMaterial();
  } catch {
    return json(
      { error: "token_secret_not_configured", detail: "PULSE_TOKEN_SECRET が未設定です（docs/PULSE_ACTIVATION_RUNBOOK.md ①-1-6）" },
      500,
    );
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: cycle, error: cErr } = await admin
    .from("pulse_cycles")
    .select("id, period, due_date, send_date, status")
    .eq("id", cycleId)
    .single();
  if (cErr || !cycle) return json({ error: "cycle not found" }, 404);
  if (mode !== "preview" && cycle.status !== "sent") {
    return json({ error: `cycle is not open for answers (status=${cycle.status})` }, 409);
  }

  // ── 文面テンプレ（pulse_settings シングルトン・無ければコード側既定文） ──
  const { data: settingsRow } = await admin
    .from("pulse_settings")
    .select("notify_broadcast_template, notify_reminder_template, notify_email_subject_template, reminder_max_count, survey_minutes")
    .eq("id", 1)
    .maybeSingle();

  const broadcastTemplate = (settingsRow?.notify_broadcast_template ?? "").trim() || DEFAULT_BROADCAST_TEMPLATE;
  const reminderTemplate = (settingsRow?.notify_reminder_template ?? "").trim() || DEFAULT_REMINDER_TEMPLATE;
  const emailSubjectTemplate = (settingsRow?.notify_email_subject_template ?? "").trim() || DEFAULT_EMAIL_SUBJECT_TEMPLATE;
  const reminderMaxCount = typeof settingsRow?.reminder_max_count === "number"
    ? settingsRow.reminder_max_count
    : DEFAULT_REMINDER_MAX_COUNT;
  const minutes = typeof settingsRow?.survey_minutes === "number" ? settingsRow.survey_minutes : DEFAULT_SURVEY_MINUTES;

  const monthLabel = monthLabelOf(cycle.period);
  const dueLabel = dueLabelOf(cycle.due_date);

  // ── 対象者: pulse_target_employee_numbers() ∩ 在籍 ∩ email あり ──
  const { data: targetNumbers, error: tErr } = await admin.rpc("pulse_target_employee_numbers");
  if (tErr) return json({ error: "target resolution failed: " + tErr.message }, 500);
  const targetSet = new Set((targetNumbers ?? []) as string[]);

  const { data: employees, error: eErr } = await admin
    .from("employees")
    .select("employee_number, display_name, full_name, email")
    .is("left_at", null);
  if (eErr) return json({ error: "employees fetch failed: " + eErr.message }, 500);

  const baseTargets = (employees ?? []).filter(
    (e: any) => targetSet.has(e.employee_number) && e.email && String(e.email).includes("@"),
  );

  // ══ preview: 送信しない。文面と（本人が対象者なら）自分用URLだけ返す ══
  if (mode === "preview") {
    const myEmployee = callerEmployeeNumber
      ? baseTargets.find((e: any) => e.employee_number === callerEmployeeNumber) ?? null
      : null;

    let myUrl: string | null = null;
    if (myEmployee) {
      const token = await signPulseToken({
        cycleId: cycleId!,
        employeeNumber: myEmployee.employee_number,
        exp: expForCycle(cycle),
      });
      myUrl = `${APP_URL}/#/survey?t=${token}`;
    }

    const previewVars = {
      name: myEmployee ? nameOf(myEmployee) : "○○",
      month: monthLabel,
      period: cycle.period,
      url: myUrl ?? `${APP_URL}/#/survey?t=<token>`,
      due: dueLabel,
      minutes: String(minutes),
    };

    return json({
      ok: true,
      mode: "preview",
      targets: baseTargets.length,
      my_url: myUrl,
      text_broadcast: renderTemplate(broadcastTemplate, previewVars),
      text_reminder: renderTemplate(reminderTemplate, previewVars),
      email_subject: renderTemplate(emailSubjectTemplate, previewVars),
    });
  }

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

  const period = cycle.period;
  const kind = mode; // "broadcast" | "reminder"
  const counts = { targets: 0, slack_ok: 0, slack_fail: 0, email_ok: 0, email_fail: 0, skipped: 0 };
  const notifRows: any[] = [];

  // ══ broadcast: 対象者全員。同一cycle・同一channelで送信済み(status='sent')の
  //     人はそのチャネルをスキップ（冪等・再実行安全） ══
  if (mode === "broadcast") {
    counts.targets = baseTargets.length;

    const { data: existingSent } = await admin
      .from("pulse_notifications")
      .select("employee_number, channel")
      .eq("cycle_id", cycleId)
      .eq("kind", "broadcast")
      .eq("status", "sent");
    const alreadySent = new Set((existingSent ?? []).map((r: any) => `${r.employee_number}:${r.channel}`));

    await mapLimit(baseTargets, 5, async (e: any) => {
      const wantSlack = !!SLACK_BOT_TOKEN && !alreadySent.has(`${e.employee_number}:slack`);
      const wantEmail = !!RESEND_API_KEY && !alreadySent.has(`${e.employee_number}:email`);
      if (SLACK_BOT_TOKEN && !wantSlack) counts.skipped++;
      if (RESEND_API_KEY && !wantEmail) counts.skipped++;
      if (!wantSlack && !wantEmail) return;

      const token = await signPulseToken({
        cycleId: cycleId!,
        employeeNumber: e.employee_number,
        exp: expForCycle(cycle),
      });
      const url = `${APP_URL}/#/survey?t=${token}`;
      const vars = { name: nameOf(e), month: monthLabel, period, url, due: dueLabel, minutes: String(minutes) };
      const msg = renderTemplate(broadcastTemplate, vars);
      const subject = renderTemplate(emailSubjectTemplate, vars);

      const [slackOk, mailOk] = await Promise.all([
        wantSlack ? slackDM(e.email, msg) : Promise.resolve(null),
        wantEmail ? sendEmail(e.email, subject, msg) : Promise.resolve(null),
      ]);

      if (wantSlack) {
        notifRows.push({ cycle_id: cycleId, employee_number: e.employee_number, channel: "slack", kind, status: slackOk ? "sent" : "failed" });
        slackOk ? counts.slack_ok++ : counts.slack_fail++;
      }
      if (wantEmail) {
        notifRows.push({ cycle_id: cycleId, employee_number: e.employee_number, channel: "email", kind, status: mailOk ? "sent" : "failed" });
        mailOk ? counts.email_ok++ : counts.email_fail++;
      }
    });
  }

  // ══ reminder: 未回答の対象者のみ。上限回数・JST同日重複を防止し、
  //     reminder_no（本人×サイクル通し番号）を付けて記録 ══
  if (mode === "reminder") {
    const { data: responded } = await admin
      .from("pulse_responses")
      .select("employee_number")
      .eq("cycle_id", cycleId);
    const done = new Set((responded ?? []).map((r: any) => r.employee_number));
    const reminderTargets = baseTargets.filter((e: any) => !done.has(e.employee_number));
    counts.targets = reminderTargets.length;

    const { data: priorReminders } = await admin
      .from("pulse_notifications")
      .select("employee_number, reminder_no, sent_at")
      .eq("cycle_id", cycleId)
      .eq("kind", "reminder");

    const roundState = new Map<string, { roundsSent: number; lastSentJst: string | null }>();
    for (const r of (priorReminders ?? []) as any[]) {
      const emp = r.employee_number as string;
      const rn = r.reminder_no as number | null;
      const sentAt = r.sent_at as string | null;
      const cur = roundState.get(emp) ?? { roundsSent: 0, lastSentJst: null };
      if (typeof rn === "number" && rn > cur.roundsSent) cur.roundsSent = rn;
      if (sentAt) {
        const jst = jstDateStr(new Date(sentAt));
        if (!cur.lastSentJst || jst > cur.lastSentJst) cur.lastSentJst = jst;
      }
      roundState.set(emp, cur);
    }

    const todayJst = jstDateStr(new Date());

    await mapLimit(reminderTargets, 5, async (e: any) => {
      const state = roundState.get(e.employee_number) ?? { roundsSent: 0, lastSentJst: null };
      if (state.roundsSent >= reminderMaxCount) {
        counts.skipped++;
        return;
      }
      if (state.lastSentJst === todayJst) {
        counts.skipped++;
        return;
      }
      const reminderNo = state.roundsSent + 1;

      const token = await signPulseToken({
        cycleId: cycleId!,
        employeeNumber: e.employee_number,
        exp: expForCycle(cycle),
      });
      const url = `${APP_URL}/#/survey?t=${token}`;
      const vars = { name: nameOf(e), month: monthLabel, period, url, due: dueLabel, minutes: String(minutes) };
      const msg = renderTemplate(reminderTemplate, vars);
      const subject = renderTemplate(emailSubjectTemplate, vars);

      const [slackOk, mailOk] = await Promise.all([
        SLACK_BOT_TOKEN ? slackDM(e.email, msg) : Promise.resolve(null),
        RESEND_API_KEY ? sendEmail(e.email, subject, msg) : Promise.resolve(null),
      ]);

      if (SLACK_BOT_TOKEN) {
        notifRows.push({
          cycle_id: cycleId,
          employee_number: e.employee_number,
          channel: "slack",
          kind,
          status: slackOk ? "sent" : "failed",
          reminder_no: reminderNo,
        });
        slackOk ? counts.slack_ok++ : counts.slack_fail++;
      }
      if (RESEND_API_KEY) {
        notifRows.push({
          cycle_id: cycleId,
          employee_number: e.employee_number,
          channel: "email",
          kind,
          status: mailOk ? "sent" : "failed",
          reminder_no: reminderNo,
        });
        mailOk ? counts.email_ok++ : counts.email_fail++;
      }
    });
  }

  // 記録。broadcast のチャネル別スキップ・reminder の回数上限/同日重複防止は
  // すべてこの行に依存するため、失敗を握りつぶさず record_failed として返す
  // （送信自体は済んでいるので counts も返す。独立レビュー指摘）。
  let recordFailed: string | null = null;
  if (notifRows.length > 0) {
    const { error: insErr } = await admin.from("pulse_notifications").insert(notifRows);
    if (insErr) {
      console.error("pulse-notify: pulse_notifications insert failed:", insErr.message);
      recordFailed = insErr.message;
    }
  }

  if (recordFailed) {
    return json({
      ok: false,
      error: "record_failed",
      detail: "配信は実行されましたが送信記録の保存に失敗しました（再実行すると重複送信になります）: " + recordFailed,
      mode,
      period,
      channels: { slack: !!SLACK_BOT_TOKEN, email: !!RESEND_API_KEY },
      counts,
    }, 500);
  }

  return json({
    ok: true,
    mode,
    period,
    channels: { slack: !!SLACK_BOT_TOKEN, email: !!RESEND_API_KEY },
    counts,
  });
});
