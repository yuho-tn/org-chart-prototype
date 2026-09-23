import assert from "node:assert/strict";
import { STRENGTHS } from "../src/lib/strengths.ts";

assert.equal(STRENGTHS.length, 34, "ストレングス資質は34件であること");
assert.equal(new Set(STRENGTHS.map((quality) => quality.id)).size, 34, "idが重複しないこと");

for (const quality of STRENGTHS) {
  assert.ok(quality.detail?.trim(), `${quality.id}: detail が空です`);
  assert.ok(quality.detail_en?.trim(), `${quality.id}: detail_en が空です`);
  assert.equal(
    quality.detail_source,
    "Gallup CliftonStrengths",
    `${quality.id}: detail_source が不正です`,
  );
  assert.match(
    quality.detail_url ?? "",
    /^https:\/\/(?:www\.)?gallup\.com\/cliftonstrengths\//,
    `${quality.id}: detail_url が Gallup 公式URLではありません`,
  );
}

console.log("Strength details: 34/34 complete");
