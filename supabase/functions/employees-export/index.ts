// 従業員マスター(public.employees) 名簿エクスポート Edge Function。
//
// 予実アプリ(shosan-yojitsu)の /api/sync-employees が、TalentHub を社員マスタの
// 「正」として名簿属性のみ取得するための読み取り専用エンドポイント。TalentHub の
// employees は SmartHR から日次同期済（smarthr-sync）なので、SmartHR トークンを
// 予実側へ配らず、マスタのハブを TalentHub に一元化する（DESIGN_jinkenhi_v3 §4-1）。
//
// 返却は名簿属性のみ:
//   employee_number / full_name / display_name / email /
//   employment_type / department / hired_at / left_at
// ⚠️ labor_*（給与データ・丹野専用RLS）には一切触れない。
//
// 起動経路:
//   • GET + x-export-secret ヘッダ（共有シークレット EMPLOYEES_EXPORT_SECRET）。
//     smarthr-sync の x-cron-secret と同型の secret 方式。呼出元は予実側サーバのみ。
//
// 必要な secret（`supabase secrets set`）:
//   EMPLOYEES_EXPORT_SECRET … 予実アプリと共有するエクスポート用シークレット
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY は既定注入。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-export-secret",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// 返却する名簿属性のみ（給与・labor_* は含めない）。
const SELECT_COLS =
  "employee_number, full_name, display_name, email, employment_type, department, hired_at, left_at";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const EXPORT_SECRET = Deno.env.get("EMPLOYEES_EXPORT_SECRET");

  if (!EXPORT_SECRET) {
    return json({ error: "EMPLOYEES_EXPORT_SECRET が未設定です" }, 500);
  }

  // ── 認可: x-export-secret 共有シークレット照合 ──
  const secretHeader = req.headers.get("x-export-secret");
  if (secretHeader !== EXPORT_SECRET) {
    return json({ error: "permission denied" }, 403);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── 名簿属性のみを全件 SELECT（ページングで全307名を取得） ──
  // Supabase の既定上限（1000行）を越えても取りこぼさないよう range で分割。
  // クエリは必ず直列 await（pooler 地雷回避・予実側 CLAUDE.md ラチェット準拠）。
  const PAGE = 1000;
  const rows: Record<string, any>[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from("employees")
      .select(SELECT_COLS)
      .order("employee_number", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) return json({ error: error.message }, 502);
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }

  return json({ count: rows.length, employees: rows });
});
