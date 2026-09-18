/**
 * GET /api/labor-div-report?target=<DIV名>&term=5 — DIV別人件費ページ（#/labor/div/:target）用API。
 *
 * ⚠ 人件費は機密。呼び出し元本人の Supabase セッション（Authorization: Bearer <access_token>）
 * を検証し、その email が laborcost_admins（全体管理者）または labor_div_access
 * （その target 限定の許可）のどちらかに載っている場合だけ、該当DIV/プール1件分の
 * 明細（社保込み月次・メンバー内訳）を返す。他DIVのデータは一切含めない。
 *
 * 環境変数（labor-export と共通・Vercel production に投入済）:
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *
 * ⚠ Vercel の Node ランタイムは Web標準の Request ではなく node:http の
 * IncomingMessage/ServerResponse を渡す（labor-export.ts と同じ実測済みの型）。
 * api/ はバンドルされず1ファイルずつ transpile されるため、相対importは必ず .js 指定子。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createClient } from "@supabase/supabase-js";
import { buildLaborDivReport, isLaborDivTarget } from "./_lib/laborDivReport.js";
import type { TermCode } from "../src/lib/laborCost.js";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(body));
  };
  // 存在自体を匂わせない汎用の 404（labor 本体のページゲートと揃える）。
  const notFound = () => send({ error: "not_found" }, 404);

  if (req.method !== "GET") return send({ error: "method_not_allowed" }, 405);

  const supabaseUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !key) {
    return send({ error: "not_configured", message: "サーバの環境変数が未設定です" }, 503);
  }

  const rawAuth = req.headers.authorization;
  const auth = Array.isArray(rawAuth) ? (rawAuth[0] ?? "") : (rawAuth ?? "");
  if (!auth.startsWith("Bearer ") || auth.length <= 7) return notFound();
  const accessToken = auth.slice(7);

  const url = new URL(req.url ?? "/", "http://localhost");
  const targetRaw = url.searchParams.get("target") ?? "";
  const term = (url.searchParams.get("term") ?? "5") as TermCode;
  if (!isLaborDivTarget(targetRaw)) return notFound();

  const db = createClient(supabaseUrl, key, { auth: { persistSession: false } });

  try {
    // apikey は service_role でも、渡した JWT（利用者本人のセッション）で本人確認する。
    const { data: userData, error: userErr } = await db.auth.getUser(accessToken);
    const email = userData?.user?.email?.toLowerCase().trim();
    if (userErr || !email) return notFound();

    const [{ data: admin }, { data: divAccess }] = await Promise.all([
      db.from("laborcost_admins").select("email").eq("email", email).maybeSingle(),
      db.from("labor_div_access").select("email").eq("email", email).eq("target", targetRaw).maybeSingle(),
    ]);
    if (!admin && !divAccess) return notFound();

    const report = await buildLaborDivReport(supabaseUrl, key, term, targetRaw);
    return send(report);
  } catch (err) {
    console.error("[GET /api/labor-div-report] failed", err);
    return send(
      { error: "internal_error", message: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}
