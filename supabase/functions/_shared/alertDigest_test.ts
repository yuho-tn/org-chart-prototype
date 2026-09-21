// alertDigest.ts の単体テスト。
//
// pulseToken_test.ts と同じ方針: 外部依存（deno.land/std 等）を避け、最小限の
// assert ヘルパーだけで完結させる。
//
// 実行: deno test supabase/functions/_shared/alertDigest_test.ts

import {
  type AlertDigestBatch,
  composeDailyDigest,
  composeImmediate,
  normalizeClassification,
  reasonLine,
} from "./alertDigest.ts";

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

// ── reasonLine ───────────────────────────────────────────────────────

Deno.test("reasonLine: geppo_stormy single item", () => {
  const line = reasonLine("geppo_stormy", { items: [{ category: "健康", score: 1 }] });
  assertEquals(line, "健康＝荒天", "stormy single item");
});

Deno.test("reasonLine: geppo_drop2 formats prev->cur with prev_period", () => {
  const line = reasonLine("geppo_drop2", {
    items: [{ category: "仕事", prev: 4, cur: 2, prev_period: "2026-10" }],
  });
  assertEquals(line, "仕事 4→2（前回 2026-10）", "drop2 formatting");
});

Deno.test("reasonLine: geppo_rain2 joins multiple items with 中点", () => {
  const line = reasonLine("geppo_rain2", {
    items: [
      { category: "仕事", score: 2 },
      { category: "評価", score: 1 },
    ],
  });
  assertEquals(line, "仕事＝雨・評価＝荒天", "rain2 multi-item join");
});

Deno.test("reasonLine: preset_all_cloudy fixed text", () => {
  assertEquals(reasonLine("preset_all_cloudy", {}), "天気4項目すべてくもり", "all_cloudy");
});

Deno.test("reasonLine: preset_decline_3m formats series with one decimal", () => {
  const line = reasonLine("preset_decline_3m", {
    series: [{ period: "2026-09", overall: 4 }, { period: "2026-10", overall: 3.3333 }, {
      period: "2026-11",
      overall: 2.5,
    }],
  });
  assertEquals(line, "総合 4.0→3.3→2.5", "decline_3m series formatting");
});

Deno.test("reasonLine: preset_same_3m counts periods", () => {
  const line = reasonLine("preset_same_3m", {
    periods: ["2026-09", "2026-10", "2026-11"],
    scores: { 仕事: 3 },
  });
  assertEquals(line, "3か月同じ回答", "same_3m fixed text with period count");
});

Deno.test("reasonLine: preset_same_3m falls back to 3 when periods missing", () => {
  assertEquals(reasonLine("preset_same_3m", {}), "3か月同じ回答", "same_3m fallback count");
});

Deno.test("reasonLine: preset_org_change shows prev -> current department", () => {
  const line = reasonLine("preset_org_change", {
    prev_department: "A部",
    department: "B部",
    prev_period: "2026-08",
  });
  assertEquals(line, "A部 → B部", "org_change formatting");
});

Deno.test("reasonLine: preset_unanswered_3m compresses same-year period range", () => {
  const line = reasonLine("preset_unanswered_3m", { periods: ["2026-09", "2026-10", "2026-11"] });
  assertEquals(line, "2026-09〜11 未回答", "unanswered_3m same-year range");
});

Deno.test("reasonLine: preset_unanswered_3m keeps full range across year boundary", () => {
  const line = reasonLine("preset_unanswered_3m", { periods: ["2026-11", "2026-12", "2027-01"] });
  assertEquals(line, "2026-11〜2027-01 未回答", "unanswered_3m cross-year range");
});

Deno.test("reasonLine: legacy_absolute / legacy_delta keep existing keys", () => {
  assertEquals(
    reasonLine("legacy_absolute", { overall: 1.667, threshold: 2 }),
    "総合 1.7（閾値2以下）",
    "legacy_absolute",
  );
  assertEquals(
    reasonLine("legacy_delta", { overall: 2.1, prev_overall: 3.8, delta: -1.7, drop_threshold: 1.5 }),
    "総合 3.8→2.1",
    "legacy_delta",
  );
});

Deno.test("reasonLine: comment_* uses [category] summary", () => {
  assertEquals(
    reasonLine("comment_sos", { category: "SOS", summary: "要約", severity: "high" }),
    "[SOS] 要約",
    "comment_sos",
  );
  assertEquals(
    reasonLine("comment_health", { category: "体調不安", summary: "体調が優れないとの記述" }),
    "[体調不安] 体調が優れないとの記述",
    "comment_health",
  );
});

Deno.test("reasonLine: comment_* without summary omits the trailing text", () => {
  assertEquals(reasonLine("comment_org", { category: "組織課題" }), "[組織課題]", "comment_org no summary");
});

Deno.test("reasonLine: unknown rule_code falls back to reason.rule label, then fixed text", () => {
  assertEquals(reasonLine("mystery_rule", { rule: "謎ルール" }), "謎ルール", "unknown rule with label");
  assertEquals(reasonLine("mystery_rule", {}), "詳細不明", "unknown rule without label");
});

Deno.test("reasonLine: malformed reason (not an object) never throws", () => {
  assertEquals(reasonLine("geppo_stormy", null), "該当項目あり", "null reason");
  assertEquals(reasonLine("geppo_stormy", "garbage"), "該当項目あり", "string reason");
  assertEquals(reasonLine("geppo_stormy", [1, 2, 3]), "該当項目あり", "array reason");
});

// ── normalizeClassification ────────────────────────────────────────

Deno.test("normalizeClassification: valid input passes through (capped at 3, deduped)", () => {
  const result = normalizeClassification({
    categories: ["SOS", "体調不安", "SOS", "仕事", "評価"],
    primary: "SOS",
    severity: "high",
    summary: "本人からのSOS",
  });
  assertEquals(result.categories.length, 3, "max 3 categories, deduped");
  assertEquals(result.categories.join(","), "SOS,体調不安,仕事", "dedupe + cap order preserved");
  assertEquals(result.primary, "SOS", "primary kept when in categories");
  assertEquals(result.severity, "high", "severity kept when valid");
  assertEquals(result.summary, "本人からのSOS", "summary kept as-is under limit");
});

Deno.test("normalizeClassification: unknown category strings are dropped, valid ones kept", () => {
  const result = normalizeClassification({ categories: ["宇宙人", "仕事", "謎"], primary: "仕事" });
  assertEquals(result.categories.join(","), "仕事", "only valid category kept");
  assertEquals(result.primary, "仕事", "primary matches surviving category");
});

Deno.test("normalizeClassification: no valid categories falls back to 分類困難", () => {
  const result = normalizeClassification({ categories: ["宇宙人", 123, null], primary: "宇宙人" });
  assertEquals(result.categories.join(","), "分類困難", "fallback category");
  assertEquals(result.primary, "分類困難", "primary falls back with categories");
});

Deno.test("normalizeClassification: primary not in categories falls back to categories[0]", () => {
  const result = normalizeClassification({ categories: ["仕事", "評価"], primary: "組織課題" });
  assertEquals(result.primary, "仕事", "primary forced to first valid category");
});

Deno.test("normalizeClassification: invalid severity defaults to low", () => {
  assertEquals(normalizeClassification({ categories: ["仕事"], severity: "urgent" }).severity, "low", "bad severity -> low");
  assertEquals(normalizeClassification({ categories: ["仕事"] }).severity, "low", "missing severity -> low");
  assertEquals(normalizeClassification({ categories: ["仕事"], severity: "mid" }).severity, "mid", "valid mid kept");
});

Deno.test("normalizeClassification: summary is cut at 60 chars", () => {
  const longSummary = "あ".repeat(80);
  const result = normalizeClassification({ categories: ["仕事"], summary: longSummary });
  assertEquals(result.summary.length, 60, "summary truncated to 60 chars");
});

Deno.test("normalizeClassification: missing/non-string summary becomes empty string", () => {
  assertEquals(normalizeClassification({ categories: ["仕事"] }).summary, "", "missing summary -> empty");
  assertEquals(normalizeClassification({ categories: ["仕事"], summary: 12345 }).summary, "", "non-string summary -> empty");
});

Deno.test("normalizeClassification: completely invalid input never throws", () => {
  for (const bad of [null, undefined, "garbage", 123, [1, 2, 3], true]) {
    const result = normalizeClassification(bad);
    assertEquals(result.categories.join(","), "分類困難", `fallback for ${JSON.stringify(bad)}`);
    assertEquals(result.primary, "分類困難", `fallback primary for ${JSON.stringify(bad)}`);
    assertEquals(result.severity, "low", `fallback severity for ${JSON.stringify(bad)}`);
    assertEquals(result.summary, "", `fallback summary for ${JSON.stringify(bad)}`);
  }
});

// ── composeDailyDigest / composeImmediate ────────────────────────────

function baseBatch(overrides: Partial<AlertDigestBatch> = {}): AlertDigestBatch {
  return {
    recipients: [{ email: "hr@example.com", name: "人事担当" }],
    digest_enabled: true,
    immediate_enabled: true,
    alerts: [],
    open_total: 0,
    by_state: { todo: 0, doing: 0, on_hold_org: 0, done: 0, not_needed: 0 },
    ...overrides,
  };
}

Deno.test("composeDailyDigest: includes each alert's 4-field line and the footer", () => {
  const batch = baseBatch({
    open_total: 3,
    by_state: { todo: 2, doing: 1, on_hold_org: 0, done: 0, not_needed: 0 },
    alerts: [
      {
        id: "a1",
        employee_number: "10001",
        name: "山田太郎",
        department: "マーケティング部",
        rule_code: "geppo_stormy",
        rule_label: "荒天がある",
        severity: "warn",
        reason: { items: [{ category: "健康", score: 1 }] },
        comment_summary: null,
      },
      {
        id: "a2",
        employee_number: "10002",
        name: "鈴木花子",
        department: "開発部",
        rule_code: "comment_sos",
        rule_label: "SOS（自由記述）",
        severity: "critical",
        reason: { category: "SOS", summary: "強いSOSシグナル" },
        comment_summary: "強いSOSシグナル",
      },
    ],
  });

  const text = composeDailyDigest(batch, "https://shosan-talent-hub.vercel.app");

  assert(text.includes("山田太郎（マーケティング部）｜荒天がある｜健康＝荒天"), "row1 fields present: " + text);
  assert(
    text.includes("鈴木花子（開発部）｜SOS（自由記述）｜[SOS] 強いSOSシグナル｜強いSOSシグナル"),
    "row2 fields incl. comment summary present: " + text,
  );
  assert(text.includes("未完了 3件（未対応 2／対応中 1／保留 0）"), "footer counts present: " + text);
  assert(text.includes("https://shosan-talent-hub.vercel.app/#/pulse/alerts"), "footer url present: " + text);
  // critical (comment_sos) must render before warn (geppo_stormy).
  assert(text.indexOf("鈴木花子") < text.indexOf("山田太郎"), "critical severity sorted before warn: " + text);
});

Deno.test("composeImmediate: body starts with the 【即時】 prefix", () => {
  const batch = baseBatch({
    open_total: 1,
    by_state: { todo: 1, doing: 0, on_hold_org: 0, done: 0, not_needed: 0 },
    alerts: [
      {
        id: "a1",
        employee_number: "10003",
        name: "佐藤次郎",
        department: "人事部",
        rule_code: "comment_health",
        rule_label: "体調不安（自由記述）",
        severity: "critical",
        reason: { category: "体調不安", summary: "体調不良の訴え" },
        comment_summary: "体調不良の訴え",
      },
    ],
  });

  const text = composeImmediate(batch, "https://shosan-talent-hub.vercel.app");
  assert(text.startsWith("【即時】"), "immediate text must start with 【即時】 prefix: " + text.slice(0, 20));
  assert(text.includes("佐藤次郎（人事部）"), "immediate text includes the alert row: " + text);
});

Deno.test("composeDailyDigest: empty alerts still returns header + footer (no crash)", () => {
  const text = composeDailyDigest(baseBatch(), "https://shosan-talent-hub.vercel.app");
  assert(text.includes("未完了 0件（未対応 0／対応中 0／保留 0）"), "empty-batch footer: " + text);
  assert(!text.includes("undefined"), "no stray 'undefined' in empty-batch text: " + text);
});

Deno.test("composeDailyDigest: truncates to <=3500 chars and appends the omitted-count line", () => {
  const alerts: AlertDigestBatch["alerts"] = [];
  for (let i = 0; i < 200; i++) {
    alerts.push({
      id: `a${i}`,
      employee_number: String(10000 + i),
      name: `従業員${i}`,
      department: "テスト部",
      rule_code: "preset_all_cloudy",
      rule_label: "全項目くもり",
      severity: "info",
      reason: {},
      comment_summary: null,
    });
  }
  const batch = baseBatch({ open_total: 200, by_state: { todo: 200, doing: 0, on_hold_org: 0, done: 0, not_needed: 0 }, alerts });

  const text = composeDailyDigest(batch, "https://shosan-talent-hub.vercel.app");

  assert(text.length <= 3500, `truncated text must be <=3500 chars, got ${text.length}`);
  assert(/…ほか \d+ 件/.test(text), "must contain the omitted-count marker: " + text.slice(-120));
  // footer must always survive truncation (it's the actionable part of the message).
  assert(text.includes("未完了 200件"), "footer counts must survive truncation: " + text.slice(-200));
  assert(text.includes("/#/pulse/alerts"), "footer url must survive truncation: " + text.slice(-200));
});

Deno.test("composeDailyDigest: small batch under the limit is not truncated (no omitted-count marker)", () => {
  const batch = baseBatch({
    open_total: 1,
    by_state: { todo: 1, doing: 0, on_hold_org: 0, done: 0, not_needed: 0 },
    alerts: [
      {
        id: "a1",
        employee_number: "10001",
        name: "山田太郎",
        department: "マーケティング部",
        rule_code: "preset_all_cloudy",
        rule_label: "全項目くもり",
        severity: "info",
        reason: {},
        comment_summary: null,
      },
    ],
  });
  const text = composeDailyDigest(batch, "https://shosan-talent-hub.vercel.app");
  assert(!/…ほか \d+ 件/.test(text), "small batch must not be marked as truncated: " + text);
});
