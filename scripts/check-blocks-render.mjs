import assert from "node:assert/strict";
import { isValidElement } from "react";
import {
  normalizeBlocks,
  textToListItems,
} from "../src/lib/profileBlocks.ts";
import { renderInline } from "../src/lib/inlineText.ts";

const sanitized = normalizeBlocks([
  {
    id: "unsafe-markup",
    type: "text",
    text: [
      "<aside>",
      "残す本文",
      "</aside>",
      '<file src="notion://asset">',
      "</file>",
      "---",
      "> 引用マーカーを外す",
    ].join("\n"),
  },
]);

assert.equal(sanitized.length, 1);
assert.equal(sanitized[0].type, "text");
if (sanitized[0].type === "text") {
  assert.equal(sanitized[0].text, "残す本文\n引用マーカーを外す");
  assert.doesNotMatch(sanitized[0].text, /<\/?aside|<\/?file|---/);
}

const normalized = normalizeBlocks([
  { id: "bad-layout", type: "heading", text: "見出し", layout: "center", level: 99 },
  { id: "unknown", type: "video", url: "https://example.com" },
]);
assert.equal(normalized.length, 1, "未知のtypeは捨てること");
assert.equal(normalized[0].type, "heading");
assert.equal(normalized[0].layout, undefined, "不正なlayoutは落とすこと");
if (normalized[0].type === "heading") assert.equal(normalized[0].level, 2);

const unsafeInline = renderInline("[x](javascript:alert(1))");
assert.equal(
  unsafeInline.some((node) => isValidElement(node) && node.type === "a"),
  false,
  "javascript: URLをリンクにしないこと",
);
assert.equal(unsafeInline.join(""), "x");

const listItems = textToListItems("- a\n- b");
assert.ok(listItems, "箇条書きだけの本文はlistへ変換できること");
assert.equal(listItems.length, 2);
assert.deepEqual(listItems.map((item) => item.text), ["a", "b"]);

console.log("block render checks: 8/8 passed");
