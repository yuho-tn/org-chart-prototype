// pulseToken.ts の単体テスト。
//
// 外部依存（deno.land/std 等のリモートモジュール）を避け、最小限の assert
// ヘルパーだけで完結させる（edge function 検証環境のネットワーク事情に
// 依存させないため）。
//
// 実行: deno test supabase/functions/_shared/pulseToken_test.ts

import {
  expForCycle,
  signPulseToken,
  verifyPulseToken,
  verifyPulseTokenDetailed,
} from "./pulseToken.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

function assertEquals<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `assertion failed: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
  }
}

const KEY_A = "test-key-material-AAAA";
const KEY_B = "test-key-material-BBBB";

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

Deno.test("sign -> verify round trip returns the same payload", async () => {
  const cycleId = "11111111-1111-4111-8111-111111111111";
  const employeeNumber = "10018";
  const exp = nowSeconds() + 3600;

  const token = await signPulseToken({ cycleId, employeeNumber, exp }, KEY_A);
  const verified = await verifyPulseToken(token, KEY_A);

  assert(verified !== null, "verified should not be null");
  assertEquals(verified!.cycleId, cycleId, "cycleId round trip");
  assertEquals(verified!.employeeNumber, employeeNumber, "employeeNumber round trip");
  assertEquals(verified!.exp, exp, "exp round trip");
});

Deno.test("tampered token (flipped signature char) is rejected", async () => {
  const token = await signPulseToken(
    { cycleId: "c1", employeeNumber: "10018", exp: nowSeconds() + 3600 },
    KEY_A,
  );
  const parts = token.split(".");
  const sig = parts[4];
  // 署名の先頭1文字を別のbase64url文字に差し替える（改竄）。
  const flippedChar = sig[0] === "A" ? "B" : "A";
  parts[4] = flippedChar + sig.slice(1);
  const tampered = parts.join(".");

  const verified = await verifyPulseToken(tampered, KEY_A);
  assertEquals(verified, null, "tampered token must be rejected");

  const detailed = await verifyPulseTokenDetailed(tampered, KEY_A);
  assert(!detailed.ok, "detailed result should be ok:false");
  if (!detailed.ok) {
    assertEquals(detailed.reason, "bad_signature", "reason should be bad_signature");
  }
});

Deno.test("tampered token (mutated payload segment) is rejected", async () => {
  const token = await signPulseToken(
    { cycleId: "c1", employeeNumber: "10018", exp: nowSeconds() + 3600 },
    KEY_A,
  );
  const parts = token.split(".");
  // employee_number segment (index 2) の末尾に1文字追記して改変する
  // （署名は元のpayloadのまま＝再署名していない改竄）。
  parts[2] = parts[2] + "x";
  const tampered = parts.join(".");

  const verified = await verifyPulseToken(tampered, KEY_A);
  assertEquals(verified, null, "tampered payload must be rejected");
});

Deno.test("expired token is rejected (exp in the past)", async () => {
  const token = await signPulseToken(
    { cycleId: "c1", employeeNumber: "10018", exp: nowSeconds() - 10 },
    KEY_A,
  );
  const verified = await verifyPulseToken(token, KEY_A);
  assertEquals(verified, null, "expired token must be rejected");

  const detailed = await verifyPulseTokenDetailed(token, KEY_A);
  assert(!detailed.ok, "detailed result should be ok:false");
  if (!detailed.ok) {
    assertEquals(detailed.reason, "expired", "reason should be expired");
  }
});

Deno.test("token signed with a different key is rejected", async () => {
  const token = await signPulseToken(
    { cycleId: "c1", employeeNumber: "10018", exp: nowSeconds() + 3600 },
    KEY_A,
  );
  const verified = await verifyPulseToken(token, KEY_B);
  assertEquals(verified, null, "token verified with the wrong key must be rejected");

  const detailed = await verifyPulseTokenDetailed(token, KEY_B);
  assert(!detailed.ok, "detailed result should be ok:false");
  if (!detailed.ok) {
    assertEquals(detailed.reason, "bad_signature", "reason should be bad_signature under a different key");
  }
});

Deno.test("employee_number containing '.' and '|' round-trips exactly", async () => {
  const cycleId = "22222222-2222-4222-8222-222222222222";
  const employeeNumber = "10018.|テスト|日本語.名前";
  const exp = nowSeconds() + 3600;

  const token = await signPulseToken({ cycleId, employeeNumber, exp }, KEY_A);
  // トークンは常にちょうど5つの "." 区切りセグメントを持つ（区切り文字
  // 衝突が構造的に起きていないことの直接検証）。
  assertEquals(token.split(".").length, 5, "token must have exactly 5 dot-separated segments");

  const verified = await verifyPulseToken(token, KEY_A);
  assert(verified !== null, "verified should not be null");
  assertEquals(verified!.employeeNumber, employeeNumber, "employeeNumber with special chars round trip");
  assertEquals(verified!.cycleId, cycleId, "cycleId round trip alongside special-char employeeNumber");
});

Deno.test("malformed tokens (garbage / missing segment / wrong version) are rejected", async () => {
  const garbage = "not-a-real-token";
  assertEquals(await verifyPulseToken(garbage, KEY_A), null, "garbage string rejected");

  const detailedGarbage = await verifyPulseTokenDetailed(garbage, KEY_A);
  assert(!detailedGarbage.ok, "garbage should be ok:false");
  if (!detailedGarbage.ok) {
    assertEquals(detailedGarbage.reason, "malformed", "garbage reason should be malformed");
  }

  const validToken = await signPulseToken(
    { cycleId: "c1", employeeNumber: "10018", exp: nowSeconds() + 3600 },
    KEY_A,
  );

  // バージョンを "v1" -> "v2" に差し替え。
  const wrongVersion = "v2" + validToken.slice(2);
  const detailedVersion = await verifyPulseTokenDetailed(wrongVersion, KEY_A);
  assert(!detailedVersion.ok, "wrong version should be ok:false");
  if (!detailedVersion.ok) {
    assertEquals(detailedVersion.reason, "malformed", "wrong version reason should be malformed");
  }

  // 署名セグメントを欠落させる（4セグメントのみ）。
  const tooFewSegments = validToken.split(".").slice(0, 4).join(".");
  assertEquals(await verifyPulseToken(tooFewSegments, KEY_A), null, "missing signature segment rejected");

  // 空文字列・巨大文字列も malformed。
  assertEquals(await verifyPulseToken("", KEY_A), null, "empty string rejected");
  assertEquals(await verifyPulseToken("a".repeat(5000), KEY_A), null, "oversized string rejected");
});

Deno.test("expForCycle: due_date present -> 23:59:59 JST of due_date", () => {
  const exp = expForCycle({ due_date: "2026-11-30", send_date: "2026-11-15" });
  // 2026-11-30 23:59:59 JST == 2026-11-30 14:59:59 UTC
  const expected = Date.UTC(2026, 10, 30, 14, 59, 59, 0) / 1000;
  assertEquals(exp, expected, "due_date based expiry");
});

Deno.test("expForCycle: no due_date, send_date present -> (send_date+31d) 23:59:59 JST", () => {
  const exp = expForCycle({ due_date: null, send_date: "2026-11-01" });
  // 2026-11-01 + 31 days = 2026-12-02
  const expected = Date.UTC(2026, 11, 2, 14, 59, 59, 0) / 1000;
  assertEquals(exp, expected, "send_date+31d based expiry");
});

Deno.test("expForCycle: neither date present -> now + 31 days (within tolerance)", () => {
  const before = Date.now() / 1000;
  const exp = expForCycle({ due_date: null, send_date: null });
  const after = Date.now() / 1000;
  const expectedLow = before + 31 * 24 * 3600 - 2;
  const expectedHigh = after + 31 * 24 * 3600 + 2;
  assert(exp >= expectedLow && exp <= expectedHigh, "now+31d within tolerance");
});

Deno.test("expForCycle: due_date takes precedence even when send_date is also present", () => {
  const exp = expForCycle({ due_date: "2026-01-05", send_date: "2025-12-01" });
  const expected = Date.UTC(2026, 0, 5, 14, 59, 59, 0) / 1000;
  assertEquals(exp, expected, "due_date must win over send_date when both present");
});
