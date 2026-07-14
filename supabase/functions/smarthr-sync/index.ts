// SmartHR API → 従業員マスター(public.employees)同期 Edge Function。
//
// SmartHR を従業員マスターの「正」とし、crews(従業員リスト)を全ページ取得して
// employees に upsert する。ブラウザから直接 SmartHR API は叩けない（CORS＋
// トークン露出）ため、トークンを secret に隠したこのサーバ側で実行する。
//
// 起動経路（pulse-notify と同型）:
//   • 手動: TalentHub 管理者が「SmartHR同期」ボタン → 呼出元 JWT を
//     smarthr_can_sync() で検証（master/privileged_admin/admin）。
//   • 自動: pg_cron から x-cron-secret 付きで毎日起動。
//
// upsert 方針（migration 0036 の契約）:
//   突合キー   = employee_number (= emp_code)
//   常に上書き = full_name / email / employment_type / department /
//                hired_at(entered_at) / left_at(resigned_at)
//   値がある時のみ = position_title（大半が空なので空で既存を消さない）
//   触らない   = display_name / career_track / プロフィール拡張
//   削除しない（退職者は left_at で表現）
//
// 必要な secret（`supabase secrets set`）:
//   SMARTHR_SUBDOMAIN     … 例 "sho-san20220722mk"（https://<sub>.smarthr.jp）
//   SMARTHR_ACCESS_TOKEN  … SmartHR アクセストークン（Bearer）
//   SMARTHR_CRON_SECRET   … cron 自動起動の共有シークレット
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

type Crew = Record<string, any>;

/** SmartHR crew → employees 行（常に上書きする列）。 */
function toBaseRow(c: Crew) {
  const last = String(c.last_name ?? "").trim();
  const first = String(c.first_name ?? "").trim();
  const fullName = [last, first].filter(Boolean).join(" ") || null;
  const et = c.employment_type;
  return {
    employee_number: String(c.emp_code ?? "").trim(),
    full_name: fullName,
    email: c.email ? String(c.email).toLowerCase() : null,
    employment_type: et && typeof et === "object" ? (et.name ?? null) : (et ?? null),
    department: c.department ? String(c.department) : null, // 階層フルパス（公式構造）
    hired_at: c.entered_at ?? null,
    left_at: c.resigned_at ?? null, // null なら在籍（＝在籍復帰も反映）
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const SUBDOMAIN = Deno.env.get("SMARTHR_SUBDOMAIN");
  const TOKEN = Deno.env.get("SMARTHR_ACCESS_TOKEN");
  const CRON_SECRET = Deno.env.get("SMARTHR_CRON_SECRET");

  if (!SUBDOMAIN || !TOKEN) {
    return json({ error: "SMARTHR_SUBDOMAIN / SMARTHR_ACCESS_TOKEN が未設定です" }, 500);
  }

  // ── 認可: cron(x-cron-secret) か、管理者 JWT(smarthr_can_sync) ──
  const cronHeader = req.headers.get("x-cron-secret");
  const isCron = !!CRON_SECRET && cronHeader === CRON_SECRET;
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

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const base = `https://${SUBDOMAIN}.smarthr.jp/api/v1`;

  // ── SmartHR crews 全ページ取得（per_page=100・x-total-count で停止） ──
  const crews: Crew[] = [];
  let total = Infinity;
  try {
    for (let page = 1; crews.length < total && page <= 100; page++) {
      const res = await fetch(`${base}/crews?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`SmartHR API ${res.status}: ${body.slice(0, 200)}`);
      }
      if (page === 1) {
        const tc = Number(res.headers.get("x-total-count"));
        if (Number.isFinite(tc) && tc > 0) total = tc;
      }
      const batch = (await res.json()) as Crew[];
      if (!Array.isArray(batch) || batch.length === 0) break;
      crews.push(...batch);
      if (batch.length < 100) break;
    }
  } catch (e) {
    await admin.from("smarthr_sync_state").upsert({
      id: true,
      last_run_at: new Date().toISOString(),
      last_status: "error",
      summary: { error: (e as Error).message },
      updated_at: new Date().toISOString(),
    });
    return json({ error: (e as Error).message }, 502);
  }

  // ── 射影 & upsert ──
  const baseRows = crews.map(toBaseRow).filter((r) => r.employee_number);
  // position は SmartHR に値がある人のみ（空で既存 position_title を消さない）
  const posRows = crews
    .map((c) => ({
      employee_number: String(c.emp_code ?? "").trim(),
      position_title: c.position ? String(c.position) : null,
    }))
    .filter((r) => r.employee_number && r.position_title);

  const errors: string[] = [];
  const CHUNK = 200;
  for (let i = 0; i < baseRows.length; i += CHUNK) {
    const slice = baseRows.slice(i, i + CHUNK);
    const { error } = await admin
      .from("employees")
      .upsert(slice, { onConflict: "employee_number" });
    if (error) errors.push(`base ${i}-${i + slice.length}: ${error.message}`);
  }
  for (let i = 0; i < posRows.length; i += CHUNK) {
    const slice = posRows.slice(i, i + CHUNK);
    const { error } = await admin
      .from("employees")
      .upsert(slice, { onConflict: "employee_number" });
    if (error) errors.push(`position ${i}-${i + slice.length}: ${error.message}`);
  }

  const byStatus = (s: string) => crews.filter((c) => c.emp_status === s).length;
  const summary = {
    fetched: crews.length,
    upserted: baseRows.length, // upsert 試行行数（社員番号あり）。失敗は errors 参照
    employed: byStatus("employed"),
    absent: byStatus("absent"),
    retired: byStatus("retired"),
    position_updated: posRows.length,
    errors,
  };

  await admin.from("smarthr_sync_state").upsert({
    id: true,
    last_run_at: new Date().toISOString(),
    last_status: errors.length ? "error" : "ok",
    summary,
    updated_at: new Date().toISOString(),
  });

  return json(summary, errors.length ? 207 : 200);
});
