/**
 * GET /api/labor-export?term=5 — PL（shosan-5th-pl-tool）へ人件費を渡す認証付きエンドポイント。
 *
 * ⚠ 人件費は機密。Bearer 必須・無認証公開は不可。
 * 環境変数（Vercel production に投入）:
 *   SUPABASE_URL                … talent-hub の Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   … labor_* は default-deny RLS のため service_role が必要
 *   LABOR_EXPORT_SECRET         … 呼び出し側(PL)と共有する bearer トークン
 */
import { buildLaborExport, fetchLaborTables } from "./_lib/laborExport.ts";
import type { TermCode } from "../src/lib/laborCost.ts";

/** 長さの違いも含めて分岐時間を一定にする（トークンの総当たり短縮を防ぐ）。 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export default async function handler(req: Request): Promise<Response> {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const secret = process.env.LABOR_EXPORT_SECRET;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !url || !key) {
    // 未設定のまま素通しさせない（機密データの無認証公開を確実に防ぐ）。
    return json({ error: "not_configured", message: "サーバの環境変数が未設定です" }, 503);
  }

  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), secret)) {
    return json({ error: "unauthorized" }, 401);
  }

  const term = (new URL(req.url).searchParams.get("term") ?? "5") as TermCode;

  try {
    const tables = await fetchLaborTables(url, key);
    return json(buildLaborExport(tables, term));
  } catch (err) {
    console.error("[GET /api/labor-export] failed", err);
    return json(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
