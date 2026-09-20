// パルスサーベイ 本人専用トークンURL 回答 Edge Function（v3 P1）。
//
// #/survey?t=<token> からログイン無しで回答できるようにする経路。
// 認可は Authorization ヘッダ（JWT）ではなく本人専用トークン（_shared/pulseToken.ts）
// のみで行うため、**このファイルは --no-verify-jwt でデプロイすること**
// （PULSE_PROVISIONING.md §0 参照。verify_jwt=true で上書きデプロイすると
// トークン回答が全滅する）。
//
//   POST { t: string, action: "get" | "submit", answers?: [...], comment?: string }
//
//   get:
//     token検証失敗    → 400 { error: "invalid_token" }
//     期限切れ         → 410 { error: "expired" }
//     cycle 不在       → 404 { error: "not_found" }
//     cycle.status<>'sent' → 409 { error: "closed" }
//     bundle RPC が null   → 404 { error: "not_found" }
//     is_target=false  → 403 { error: "not_target" }
//     成功             → 200 { ok: true, bundle }
//
//   submit: 上記に加えて answers/comment のクライアント側検証（RPCが最終防衛）。
//     RPC例外に "not_target" を含む → 403 { error: "not_target" }
//     それ以外の例外                 → 400 { error: "submit_failed", detail }
//     成功 → bundle を再取得して 200 { ok: true, bundle }
//
// 返すのは bundle のみ（email・他人・履歴・集計は一切返さない）。
// token・employee_number はログ出力しない。
//
// cycle_id は常にトークン由来のものだけを使う（body の cycle_id は受け取らない
// ＝これによりトークンを持つ本人以外が任意サイクルを覗く経路を作らない）。
//
// 必要な env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（既定注入）。
// トークン検証鍵は _shared/pulseToken.ts 側で PULSE_TOKEN_SECRET（任意）
// ?? SUPABASE_SERVICE_ROLE_KEY から解決する。
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { type PulseTokenVerifyResult, verifyPulseTokenDetailed } from "../_shared/pulseToken.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_ANSWERS = 50;
const MAX_TEXT_LEN = 2000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

interface AnswerInput {
  question_id: string;
  score: number | null;
  value_text: string | null;
}

type AnswersValidation =
  | { ok: true; answers: AnswerInput[]; comment: string | null }
  | { ok: false; reason: string };

/** submit の answers/comment をクライアント側で軽量検証する（RPC側が最終防衛）。 */
function validateSubmitInput(rawAnswers: unknown, rawComment: unknown): AnswersValidation {
  if (rawAnswers !== undefined && rawAnswers !== null && !Array.isArray(rawAnswers)) {
    return { ok: false, reason: "answers must be an array" };
  }
  const arr: unknown[] = Array.isArray(rawAnswers) ? rawAnswers : [];
  if (arr.length > MAX_ANSWERS) {
    return { ok: false, reason: `answers exceeds ${MAX_ANSWERS} items` };
  }

  const answers: AnswerInput[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, reason: "each answer must be an object" };
    }
    const a = raw as Record<string, unknown>;

    const qid = a.question_id;
    if (typeof qid !== "string" || qid.trim() === "") {
      return { ok: false, reason: "question_id must be a non-empty string" };
    }

    let score: number | null = null;
    if (a.score !== null && a.score !== undefined) {
      if (typeof a.score !== "number" || !Number.isFinite(a.score)) {
        return { ok: false, reason: "score must be a number or null" };
      }
      score = a.score;
    }

    let value_text: string | null = null;
    if (a.value_text !== null && a.value_text !== undefined) {
      if (typeof a.value_text !== "string") {
        return { ok: false, reason: "value_text must be a string or null" };
      }
      if (a.value_text.length > MAX_TEXT_LEN) {
        return { ok: false, reason: `value_text exceeds ${MAX_TEXT_LEN} characters` };
      }
      value_text = a.value_text;
    }

    answers.push({ question_id: qid, score, value_text });
  }

  let comment: string | null = null;
  if (rawComment !== null && rawComment !== undefined) {
    if (typeof rawComment !== "string") {
      return { ok: false, reason: "comment must be a string or null" };
    }
    if (rawComment.length > MAX_TEXT_LEN) {
      return { ok: false, reason: `comment exceeds ${MAX_TEXT_LEN} characters` };
    }
    comment = rawComment;
  }

  return { ok: true, answers, comment };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const token = typeof body?.t === "string" ? body.t : null;
  const action = body?.action;
  if (!token) return json({ error: "invalid_token" }, 400);
  if (action !== "get" && action !== "submit") {
    return json({ error: "invalid_action" }, 400);
  }

  // ── トークン検証（材料未設定等の内部エラーは 500・それ以外は 400/410） ──
  let verified: PulseTokenVerifyResult;
  try {
    verified = await verifyPulseTokenDetailed(token);
  } catch (e) {
    console.error("pulse-answer: token verify internal error:", (e as Error).message);
    return json({ error: "internal_error" }, 500);
  }
  if (!verified.ok) {
    if (verified.reason === "expired") return json({ error: "expired" }, 410);
    return json({ error: "invalid_token" }, 400); // malformed / bad_signature
  }
  const { cycleId, employeeNumber } = verified.payload;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // ── サイクルの存在・受付中チェック（cycle_id は常にトークン由来のみ使用） ──
  const { data: cycle, error: cErr } = await admin
    .from("pulse_cycles")
    .select("id, status")
    .eq("id", cycleId)
    .maybeSingle();
  if (cErr) {
    console.error("pulse-answer: cycle fetch failed:", cErr.message);
    return json({ error: "internal_error" }, 500);
  }
  if (!cycle) return json({ error: "not_found" }, 404);
  if (cycle.status !== "sent") return json({ error: "closed" }, 409);

  if (action === "get") {
    const { data: bundle, error: bErr } = await admin.rpc("pulse_survey_bundle_for", {
      p_emp: employeeNumber,
      p_cycle_id: cycleId,
    });
    if (bErr) {
      console.error("pulse-answer: bundle rpc failed:", bErr.message);
      return json({ error: "internal_error" }, 500);
    }
    if (!bundle) return json({ error: "not_found" }, 404);
    if (bundle.is_target === false) return json({ error: "not_target" }, 403);
    return json({ ok: true, bundle });
  }

  // ── action === "submit" ──
  const validation = validateSubmitInput(body?.answers, body?.comment);
  if (!validation.ok) {
    return json({ error: "invalid_input", detail: validation.reason }, 400);
  }

  const { error: subErr } = await admin.rpc("pulse_submit_response_for", {
    p_emp: employeeNumber,
    p_cycle_id: cycleId,
    p_answers: validation.answers,
    p_comment: validation.comment,
  });
  if (subErr) {
    const msg = subErr.message ?? "submit failed";
    if (msg.includes("not_target")) return json({ error: "not_target" }, 403);
    if (msg.includes("not open for responses")) return json({ error: "closed" }, 409);
    // detail はこちらの検証文言（pulse__submit_response: …）だけを返し、
    // それ以外の DB 生エラーはログに回してクライアントへ出さない（独立レビュー指摘）。
    console.error("pulse-answer: submit rpc failed:", msg);
    const ours = msg.includes("pulse__submit_response:");
    return json(
      ours ? { error: "submit_failed", detail: msg.replace(/^.*pulse__submit_response:\s*/, "") } : { error: "submit_failed" },
      400,
    );
  }

  const { data: bundleAfter, error: bErr2 } = await admin.rpc("pulse_survey_bundle_for", {
    p_emp: employeeNumber,
    p_cycle_id: cycleId,
  });
  if (bErr2) {
    console.error("pulse-answer: bundle rpc (after submit) failed:", bErr2.message);
    return json({ error: "internal_error" }, 500);
  }
  if (!bundleAfter) return json({ error: "not_found" }, 404);
  return json({ ok: true, bundle: bundleAfter });
});
