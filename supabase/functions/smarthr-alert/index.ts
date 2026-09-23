// SmartHR 同期の失敗通知 Edge Function（migration 0054）。
//
// 日次同期が壊れたことを人事管理者へ Slack DM で知らせる。
//
// 背景（2026-09-23）: サブドメイン改称で同期が 400 を返し続けていたが、失敗は
// smarthr_sync_state に書かれるだけで誰にも届かず、発見時には従業員マスターが
// 7件（入社3・退職4）ズレていた。「画面に出ている」は気づく仕組みではない。
//
//   POST { mode: "check" | "preview" }
//
//   • check   : pg_cron（0054 smarthr_cron_fire_sync_alert）から毎日起動される本体。
//               smarthr_alert_batch() が「今通知すべきか」を判定し、
//                 kind='failure'  … 異常（error / stale / never）
//                 kind='recovery' … 直前まで通知していた障害からの復旧（1回だけ）
//                 kind=null       … 送らない（正常のまま／抑止期間内／alert_enabled=false）
//               1人以上へ送れたら smarthr_mark_alerted() で記録する。
//               送信が全滅した時は記録しない＝次回また試す。
//   • preview : 送信も記録も一切しない。「今送るとこうなる」を返すだけ。
//
// 通知の間引き（migration 0054 の契約）:
//   同じ原因は 24 時間に1回まで。原因が変わったら抑止期間内でも即通知する。
//   毎日同じ文面が届く状態を作ると、人はアラートを読まなくなる。
//
// 認可（smarthr-sync と同型）:
//   check   = x-cron-secret（SMARTHR_CRON_SECRET）か、管理者 JWT（smarthr_can_sync）。
//   preview = 管理者 JWT のみ（cron 起動不可）。
//
// 必要な secret（新規は無し・smarthr-sync / pulse-notify と共用）:
//   SLACK_BOT_TOKEN     … Slack Bot（chat:write, users:read.email）。無ければ
//                          check は 400 no_channel_configured（preview は除外）
//   SMARTHR_CRON_SECRET … cron 起動の共有シークレット（smarthr-sync と同じ値）
//   SMARTHR_APP_URL     … 本文のリンク（既定 https://shosan-talent-hub.vercel.app）
// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// verify_jwt=false（supabase/config.toml で固定・cron が x-cron-secret のみで呼ぶため）。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Mode = "check" | "preview";
const MODES: readonly Mode[] = ["check", "preview"];

/** 異常が続いた時の再通知間隔（時間）。同じ原因はこの間隔に1回だけ。
 *  日次 cron（24h 間隔）より短くすること。24 にすると経過時間の僅差で判定を
 *  外し、壊れている間の通知が1日おきになる。 */
const REPEAT_HOURS = 20;
/** last_run_at がこの時間以上動いていなければ「cron ごと死んでいる」と見なす。 */
const STALE_HOURS = 36;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Slack DM（users.lookupByEmail → chat.postMessage）。
 *  pulse-notify / _shared/slack.ts と同型を意図的に自己完結で持つ
 *  （pulse v3 の共有モジュールは別ブランチにあり、この修正を待たせないため）。 */
async function slackDM(token: string, email: string, text: string): Promise<boolean> {
  if (!token) return false;
  try {
    const lookup = await fetch(
      "https://slack.com/api/users.lookupByEmail?email=" + encodeURIComponent(email),
      { headers: { Authorization: "Bearer " + token } },
    ).then((r) => r.json());
    const uid = lookup?.user?.id;
    if (!lookup?.ok || !uid) return false;

    const post = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ channel: uid, text }),
    }).then((r) => r.json());
    return !!post?.ok;
  } catch {
    return false;
  }
}

/** 限定並列（pulse-notify の mapLimit と同型）。 */
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

/** 日本にDSTは無いため +9h 固定オフセットでよい（pulse 系 jstDateStr と同型）。 */
function jstStr(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().replace("T", " ").slice(0, 16) + " JST";
}

interface Batch {
  kind: "failure" | "recovery" | null;
  alert_key: string | null;
  state: string | null;
  detail: string | null;
  last_run_at: string | null;
  age_hours: number | null;
  recipients: string[];
}

/** 状態ごとの「まず何をすればいいか」。原因を名指ししないアラートは読まれない。 */
function nextAction(state: string | null, detail: string): string {
  if (state === "error" && /inactive/i.test(detail)) {
    return [
      "SmartHR 側でサブドメインが改称された可能性が高いです。",
      "1) SmartHR にログインし、現在のサブドメイン（URL の <sub>.smarthr.jp）を確認",
      "2) supabase secrets set SMARTHR_SUBDOMAIN=<新しいサブドメイン>",
      "3) 従業員マスター画面の「⟳ SmartHR同期」で復旧を確認",
    ].join("\n");
  }
  if (state === "error" && /\b401\b/.test(detail)) {
    return [
      "SmartHR のアクセストークンが失効した可能性が高いです。",
      "1) SmartHR でアクセストークンを再発行",
      "2) supabase secrets set SMARTHR_ACCESS_TOKEN=<新しいトークン>",
      "3) 従業員マスター画面の「⟳ SmartHR同期」で復旧を確認",
    ].join("\n");
  }
  if (state === "stale" || state === "never") {
    return [
      "同期そのものが起動していません。次の順に確認してください。",
      "1) select * from cron.job に日次同期のジョブが居るか",
      "2) select * from cron.job_run_details order by start_time desc limit 10 の結果",
      "3) Vault の smarthr_cron_secret と Edge Function 側の値が一致しているか",
    ].join("\n");
  }
  return "従業員マスター画面の「⟳ SmartHR同期」を手動実行し、表示されるエラーを確認してください。";
}

function compose(b: Batch, appUrl: string): { title: string; text: string } {
  const link = `${appUrl}/#/employees`;
  if (b.kind === "recovery") {
    return {
      title: "SmartHR同期が復旧しました",
      text: [
        "✅ *SmartHR同期が復旧しました*",
        "",
        `最終同期: ${jstStr(b.last_run_at)}`,
        "",
        `従業員マスター: ${link}`,
        "",
        "※ 停止中の入社・退職は同期で自動的に反映されます。人数に違和感があれば画面でご確認ください。",
      ].join("\n"),
    };
  }
  const label = b.state === "never"
    ? "一度も実行されていません"
    : b.state === "stale"
    ? "止まっています"
    : "失敗しています";
  return {
    title: `SmartHR同期が${label}`,
    text: [
      `🚨 *SmartHR同期が${label}*`,
      "",
      `状態: ${b.state}`,
      `最終同期: ${jstStr(b.last_run_at)}${b.age_hours != null ? `（${Math.round(b.age_hours)}時間前）` : ""}`,
      `内容: ${b.detail ?? "—"}`,
      "",
      "▼ 対応",
      nextAction(b.state, b.detail ?? ""),
      "",
      `従業員マスター: ${link}`,
      "",
      "※ 同期が止まっている間、入社・退職は従業員マスターへ反映されません（過去に7件ズレた事例があります）。",
      "※ このアラートは、原因が変わらないかぎり1日1回だけ送られます。",
    ].join("\n"),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN");
  const CRON_SECRET = Deno.env.get("SMARTHR_CRON_SECRET");
  const APP_URL = Deno.env.get("SMARTHR_APP_URL") ?? "https://shosan-talent-hub.vercel.app";

  let mode: Mode = "check";
  try {
    const raw = await req.text();
    if (raw.trim()) {
      const body = JSON.parse(raw);
      if (body?.mode != null) {
        if (!MODES.includes(body.mode)) return json({ error: "invalid mode" }, 400);
        mode = body.mode as Mode;
      }
    }
  } catch {
    return json({ error: "invalid json body" }, 400);
  }

  // ── 認可: check は cron secret か管理者JWT。preview は管理者JWTのみ。 ──
  const cronHeader = req.headers.get("x-cron-secret");
  const isCron = mode !== "preview" && !!CRON_SECRET && cronHeader === CRON_SECRET;
  if (!isCron) {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader) return json({ error: "missing authorization" }, 401);
    const asUser = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: canSync, error: permErr } = await asUser.rpc("smarthr_can_sync");
    if (permErr) return json({ error: "permission check failed: " + permErr.message }, 500);
    if (!canSync) return json({ error: "permission denied" }, 403);
  }

  // 通知チャネルが無いのにサイレント no-op にしない（pulse-notify と同じ理由）。
  // ※認可チェックの後＝未認可の呼び出し元へ設定状態を漏らさない。
  if (mode === "check" && !SLACK_BOT_TOKEN) {
    return json({ error: "no_channel_configured", detail: "SLACK_BOT_TOKEN が未設定です" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.rpc("smarthr_alert_batch", {
    p_stale_hours: STALE_HOURS,
    p_repeat_hours: REPEAT_HOURS,
  });
  if (error) return json({ error: "alert batch failed: " + error.message }, 500);

  const batch = data as Batch;
  const recipients = Array.isArray(batch?.recipients) ? batch.recipients : [];

  if (mode === "preview") {
    return json({
      ok: true,
      mode,
      would_send: batch?.kind != null && recipients.length > 0,
      kind: batch?.kind ?? null,
      state: batch?.state ?? null,
      detail: batch?.detail ?? null,
      recipients,
      text: batch?.kind ? compose(batch, APP_URL).text : null,
    });
  }

  if (!batch?.kind) {
    return json({ ok: true, mode, sent: 0, skipped: "nothing_to_report", state: batch?.state ?? null });
  }
  if (recipients.length === 0) {
    // 宛先ゼロを「送った」ことにしない。誰にも届いていないのに記録すると、
    // 抑止期間のあいだ本当の障害が沈黙する。
    return json({ ok: true, mode, sent: 0, skipped: "no_recipients", state: batch.state });
  }

  const { title, text } = compose(batch, APP_URL);
  const results = await mapLimit(recipients, 3, (email) => slackDM(SLACK_BOT_TOKEN!, email, text));
  const sent = results.filter(Boolean).length;

  // 1人も届かなかったら記録しない＝次回また試す（沈黙させない）。
  if (sent > 0) {
    const { error: markErr } = await admin.rpc("smarthr_mark_alerted", {
      p_key: batch.kind === "recovery" ? null : batch.alert_key,
    });
    if (markErr) {
      return json({ ok: true, mode, kind: batch.kind, sent, mark_error: markErr.message }, 207);
    }
  }

  return json({
    ok: true,
    mode,
    kind: batch.kind,
    state: batch.state,
    title,
    sent,
    failed: recipients.length - sent,
  });
});
