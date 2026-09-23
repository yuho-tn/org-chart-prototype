import { createElement, type ReactNode } from "react";
import { safeLinkUrl } from "./profileBlocks.ts";

// 対応範囲を太字・Markdownリンク・裸URLの3種に限定する。
const INLINE_TOKEN = /\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\(((?:[^()\s]+|\([^()\s]*\))+)\)|(https?:\/\/[^\s<>"']+)/g;

/**
 * 保存済みテキストをReactノードへ安全に変換する。
 * HTML文字列を生成しないため、入力は常にReactによりエスケープされる。
 */
export function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(text.slice(cursor, index));

    const [token, boldText, linkText, linkTarget, bareUrl] = match;
    const key = `inline_${tokenIndex}`;
    tokenIndex += 1;

    if (boldText !== undefined) {
      nodes.push(createElement("strong", { key }, boldText));
    } else if (linkText !== undefined) {
      const safe = safeLinkUrl(linkTarget);
      nodes.push(
        safe
          ? createElement(
              "a",
              { key, href: safe, target: "_blank", rel: "noopener noreferrer" },
              linkText,
            )
          : linkText,
      );
    } else if (bareUrl !== undefined) {
      const safe = safeLinkUrl(bareUrl);
      nodes.push(
        createElement(
          "a",
          { key, href: safe, target: "_blank", rel: "noopener noreferrer" },
          bareUrl,
        ),
      );
    }

    cursor = index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
