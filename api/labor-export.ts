/**
 * GET /api/labor-export?term=5 — PL（shosan-5th-pl-tool）へ人件費を渡す認証付きエンドポイント。
 *
 * ⚠ 人件費は機密。Bearer 必須・無認証公開は不可。
 * 環境変数（Vercel production に投入済）:
 *   SUPABASE_URL                … talent-hub の Supabase URL
 *   SUPABASE_SERVICE_ROLE_KEY   … labor_* は default-deny RLS のため service_role が必要
 *   LABOR_EXPORT_SECRET         … 呼び出し側(PL)と共有する bearer トークン
 *
 * ⚠ Vercel の Node ランタイムは Web標準の Request ではなく node:http の
 * IncomingMessage/ServerResponse を渡す（本番実測 2026-08-16）。Web版シグネチャで書くと
 * `req.headers.get is not a function` で落ちるため、この形を崩さないこと。
 * 同様に api/ はバンドルされず1ファイルずつ transpile されるため、相対importは必ず .js 指定子。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildLaborExport, fetchLaborTables } from "./_lib/laborExport.js";
import type { TermCode } from "../src/lib/laborCost.js";

/** 長さの違いも含めて分岐時間を一定にする（トークンの総当たり短縮を防ぐ）。 */
function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };

  if (req.method !== "GET") return send({ error: "method_not_allowed" }, 405);

  const secret = process.env.LABOR_EXPORT_SECRET;
  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret || !supabaseUrl || !key) {
    // 未設定のまま素通しさせない（機密データの無認証公開を確実に防ぐ）。
    return send({ error: "not_configured", message: "サーバの環境変数が未設定です" }, 503);
  }

  const rawAuth = req.headers.authorization;
  const auth = Array.isArray(rawAuth) ? (rawAuth[0] ?? "") : (rawAuth ?? "");
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), secret)) {
    return send({ error: "unauthorized" }, 401);
  }

  // req.url はパス以降のみなのでダミーの origin を与えて解析する。
  const term = (new URL(req.url ?? "/", "http://localhost").searchParams.get("term") ??
    "5") as TermCode;

  try {
    const tables = await fetchLaborTables(supabaseUrl, key);
    return send(buildLaborExport(tables, term));
  } catch (err) {
    console.error("[GET /api/labor-export] failed", err);
    return send(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
