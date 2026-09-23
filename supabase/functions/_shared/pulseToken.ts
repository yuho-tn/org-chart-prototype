// パルス回答トークン（本人専用URL・ログイン不要）の署名・検証ユーティリティ。
//
// pulse-answer（--no-verify-jwt）と pulse-notify（配信URL生成）の両方から
// 共有する。PULSE_V3_DESIGN.md §4-1 準拠（区切り文字衝突をゼロにする設計）。
//
// トークン形式:
//   payload = "v1.<b64url(cycle_id)>.<b64url(employee_number)>.<exp_unix>"
//   token   = payload + "." + b64url(HMAC-SHA256(K, payload))
//
// cycle_id / employee_number は「フィールドを個別に」base64url してから "."
// で連結する（payload 全体をまとめて base64url する方式だと employee_number
// に任意文字が入った場合の衝突可能性を考える必要が生じるため、そもそも
// デリミタ(".")が base64url アルファベットに含まれない個別エンコードで
// 衝突自体を構造的にゼロにする）。"v1" と exp（10進数字のみ）は元々 "."
// を含み得ないため素のまま置く。
//
// 署名鍵 K は secret を直接署名鍵として使わず、固定メッセージで一段階
// 派生する（鍵の使い回し・用途分離のため）:
//   材料 = PULSE_TOKEN_SECRET（任意）?? SUPABASE_SERVICE_ROLE_KEY
//   K    = HMAC-SHA256(key=材料, msg="talenthub-pulse-answer-v1")
//   署名・検証は常に K を使う（材料そのものは使わない）。

const DERIVE_MESSAGE = "talenthub-pulse-answer-v1";
const TOKEN_VERSION = "v1";
const MAX_TOKEN_LENGTH = 2000;

export interface PulseTokenPayload {
  cycleId: string;
  employeeNumber: string;
  /** unix seconds（epoch秒）。 */
  exp: number;
}

export type PulseTokenFailureReason = "malformed" | "bad_signature" | "expired";

export type PulseTokenVerifyResult =
  | { ok: true; payload: PulseTokenPayload }
  | { ok: false; reason: PulseTokenFailureReason };

/** PULSE_TOKEN_SECRET 未設定時に投げる例外のマーカー（呼び出し元は明示エラーに変換する）。 */
export const TOKEN_SECRET_NOT_CONFIGURED = "token_secret_not_configured";

/**
 * 署名鍵の材料 = 専用 secret `PULSE_TOKEN_SECRET`（必須）。
 *
 * 当初は SUPABASE_SERVICE_ROLE_KEY へのフォールバックを持っていたが、2026-09-20 の実測で
 * Edge Runtime が注入する SUPABASE_SERVICE_ROLE_KEY はプラットフォーム都合で値が変わる
 * （legacy JWT → sb_secret_… へ切り替わっていた・CLI からは値を確認できない）ことが分かった。
 * その鍵に依存すると、配布済みの本人専用URLが月の途中で黙って全滅し得るため、
 * 用途専用で自分たちが管理する secret だけを材料にする。
 *
 * 注意: PULSE_TOKEN_SECRET を後から変更すると、既に配布済みのトークンURLはすべて
 * 検証不能になる。初回配信より前に一度だけ決めて固定する（PULSE_PROVISIONING.md §2-4）。
 * 未設定なら例外を投げる（呼び出し元は 500 `token_secret_not_configured` として返す）。
 */
export function getDefaultKeyMaterial(): string {
  const material = Deno.env.get("PULSE_TOKEN_SECRET");
  if (!material || material.trim().length < 16) {
    throw new Error(TOKEN_SECRET_NOT_CONFIGURED);
  }
  return material;
}

// ── base64url ヘルパー（UTF-8 安全・任意バイト列を扱う） ──────────────

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── HMAC ヘルパー ────────────────────────────────────────────────────

// TS 5.7+ の lib.dom.d.ts は BufferSource を ArrayBufferView<ArrayBuffer> に絞ったため、
// 既定の Uint8Array<ArrayBufferLike>（TextEncoder().encode() 等の戻り値）がそのままでは
// 型として通らない（実行時は問題無い＝ Uint8Array は常に ArrayBufferView を満たす）。
// crypto.subtle.* への受け渡し箇所でだけ明示キャストする。
function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

async function importHmacKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    asBufferSource(rawKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** K = HMAC-SHA256(key=材料, msg=DERIVE_MESSAGE)。材料を直接署名鍵として使わない。 */
async function deriveKey(keyMaterial: string): Promise<Uint8Array> {
  const materialKey = await importHmacKey(utf8Encode(keyMaterial));
  const sig = await crypto.subtle.sign("HMAC", materialKey, asBufferSource(utf8Encode(DERIVE_MESSAGE)));
  return new Uint8Array(sig);
}

async function hmacSign(K: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await importHmacKey(K);
  const sig = await crypto.subtle.sign("HMAC", key, asBufferSource(utf8Encode(message)));
  return new Uint8Array(sig);
}

/** crypto.subtle.verify は定数時間比較（タイミング攻撃対策）。 */
async function hmacVerify(K: Uint8Array, message: string, signature: Uint8Array): Promise<boolean> {
  const key = await importHmacKey(K);
  return await crypto.subtle.verify("HMAC", key, asBufferSource(signature), asBufferSource(utf8Encode(message)));
}

// ── 署名 ─────────────────────────────────────────────────────────────

/**
 * 本人専用回答URL用トークンを発行する。
 * keyMaterial を省略すると getDefaultKeyMaterial()（env）を使う。
 * テストでは固定鍵文字列を明示的に渡すことで env 非依存に検証できる。
 */
export async function signPulseToken(
  payload: PulseTokenPayload,
  keyMaterial: string = getDefaultKeyMaterial(),
): Promise<string> {
  if (!payload.cycleId) throw new Error("signPulseToken: cycleId is required");
  if (!payload.employeeNumber) throw new Error("signPulseToken: employeeNumber is required");
  if (!Number.isInteger(payload.exp)) {
    throw new Error("signPulseToken: exp must be an integer unix timestamp (seconds)");
  }

  const unsigned = [
    TOKEN_VERSION,
    base64UrlEncode(utf8Encode(payload.cycleId)),
    base64UrlEncode(utf8Encode(payload.employeeNumber)),
    String(payload.exp),
  ].join(".");

  const K = await deriveKey(keyMaterial);
  const sig = await hmacSign(K, unsigned);
  return `${unsigned}.${base64UrlEncode(sig)}`;
}

// ── 検証（内部共通ロジック） ──────────────────────────────────────────

async function parseAndVerify(token: string, keyMaterial: string): Promise<PulseTokenVerifyResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }

  const parts = token.split(".");
  if (parts.length !== 5) return { ok: false, reason: "malformed" };
  const [version, cycleB64, empB64, expStr, sigB64] = parts;

  if (version !== TOKEN_VERSION) return { ok: false, reason: "malformed" };
  if (!/^\d+$/.test(expStr)) return { ok: false, reason: "malformed" };

  let cycleId: string;
  let employeeNumber: string;
  let sigBytes: Uint8Array;
  try {
    cycleId = utf8Decode(base64UrlDecode(cycleB64));
    employeeNumber = utf8Decode(base64UrlDecode(empB64));
    sigBytes = base64UrlDecode(sigB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!cycleId || !employeeNumber) return { ok: false, reason: "malformed" };

  const exp = Number(expStr);
  if (!Number.isSafeInteger(exp)) return { ok: false, reason: "malformed" };

  const unsigned = [version, cycleB64, empB64, expStr].join(".");
  let validSig: boolean;
  try {
    const K = await deriveKey(keyMaterial);
    validSig = await hmacVerify(K, unsigned, sigBytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!validSig) return { ok: false, reason: "bad_signature" };

  // 署名が正当な場合に限り exp を信用する（改竄トークンの exp 値で
  // malformed/bad_signature 以外の分岐を誤らせないため）。
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, payload: { cycleId, employeeNumber, exp } };
}

/**
 * トークンを検証する。形式不正・署名不一致・期限切れ（exp<=now）は
 * すべて null（理由を区別しない・最小情報開示）。
 * 400 invalid_token / 410 expired を呼び分けたい呼び出し元（pulse-answer）
 * は verifyPulseTokenDetailed を使うこと。
 */
export async function verifyPulseToken(
  token: string,
  keyMaterial: string = getDefaultKeyMaterial(),
): Promise<PulseTokenPayload | null> {
  const result = await parseAndVerify(token, keyMaterial);
  return result.ok ? result.payload : null;
}

/**
 * verifyPulseToken と同じ検証だが、失敗理由を malformed / bad_signature /
 * expired で区別して返す。署名が正当な場合のみ expired 判定を返す
 * （改竄トークンの exp を信用しない）。
 */
export async function verifyPulseTokenDetailed(
  token: string,
  keyMaterial: string = getDefaultKeyMaterial(),
): Promise<PulseTokenVerifyResult> {
  return await parseAndVerify(token, keyMaterial);
}

// ── サイクルの有効期限（due_date の 23:59:59 JST） ────────────────────

function parseDateOnly(dateStr: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** dateStr（YYYY-MM-DD）の 23:59:59 JST を unix seconds で返す。 */
function jstEndOfDayUnixSeconds(dateStr: string): number {
  const parsed = parseDateOnly(dateStr);
  if (!parsed) throw new Error(`jstEndOfDayUnixSeconds: invalid date "${dateStr}"`);
  // 23:59:59 JST(UTC+9) = 14:59:59 UTC（同一暦日。日本にDST無しのため単純固定オフセットでよい）。
  const ms = Date.UTC(parsed.y, parsed.m - 1, parsed.d, 14, 59, 59, 0);
  return Math.floor(ms / 1000);
}

/** dateStr（YYYY-MM-DD）に days 日を加えた YYYY-MM-DD を返す（暦日演算・UTC基準）。 */
function addDaysToDateStr(dateStr: string, days: number): string {
  const parsed = parseDateOnly(dateStr);
  if (!parsed) throw new Error(`addDaysToDateStr: invalid date "${dateStr}"`);
  const base = Date.UTC(parsed.y, parsed.m - 1, parsed.d);
  const shifted = new Date(base + days * 86_400_000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * サイクルのトークン有効期限（unix seconds）を返す（PULSE_V3_DESIGN.md §4-1）。
 *   due_date あり             → due_date の 23:59:59 JST
 *   due_date 無し・send_date有 → (send_date + 31日) の 23:59:59 JST
 *   どちらも無し               → now + 31日（アンカーにできる日付が無いため実時刻のまま）
 */
export function expForCycle(cycle: { due_date?: string | null; send_date?: string | null }): number {
  if (cycle.due_date) {
    return jstEndOfDayUnixSeconds(cycle.due_date);
  }
  if (cycle.send_date) {
    return jstEndOfDayUnixSeconds(addDaysToDateStr(cycle.send_date, 31));
  }
  return Math.floor(Date.now() / 1000) + 31 * 24 * 3600;
}
