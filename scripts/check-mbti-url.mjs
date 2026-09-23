import assert from "node:assert/strict";
import { mbtiExternalUrl } from "../src/lib/mbti.ts";

assert.equal(
  mbtiExternalUrl("ISTP"),
  "https://www.16personalities.com/ja/istp型の性格",
);
assert.equal(
  mbtiExternalUrl("ENFP"),
  "https://www.16personalities.com/ja/enfp型の性格",
);

console.log("MBTI URL checks: 2 passed");
