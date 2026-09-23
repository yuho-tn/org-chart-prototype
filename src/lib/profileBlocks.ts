/**
 * 自由プロフィールの軽量ブロックモデル。
 * employee_profiles.blocks(jsonb) には構造化データのみを保存し、HTMLは保存しない。
 */

/** 全ブロック共通。layout は横並びの指定。 */
export type BlockBase = {
  id: string;
  /** full（既定・全幅）/ left（左half）/ right（右half）。 */
  layout?: "full" | "left" | "right";
};

export type HeadingBlock = BlockBase & {
  type: "heading";
  text: string;
  /** 2 = 大見出し（既定） / 3 = 小見出し */
  level?: 2 | 3;
};

export type TextBlock = BlockBase & { type: "text"; text: string };

/** 箇条書き。children は1段のネストまで。 */
export type ListItem = { text: string; children?: string[] };
export type ListBlock = BlockBase & {
  type: "list";
  ordered?: boolean;
  items: ListItem[];
};

export type ImageBlock = BlockBase & {
  type: "image";
  images: { path: string; caption?: string }[];
};

export type LinkBlock = BlockBase & {
  type: "link";
  url: string;
  title?: string;
  description?: string;
};

export type ProfileBlock = HeadingBlock | TextBlock | ListBlock | ImageBlock | LinkBlock;
export type BlockType = ProfileBlock["type"];

export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  heading: "見出し",
  text: "本文",
  list: "箇条書き",
  image: "画像",
  link: "リンク",
};

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLayout(value: unknown): BlockBase["layout"] {
  return value === "full" || value === "left" || value === "right" ? value : undefined;
}

/** Notion由来の表示用でない記法をテキスト値から除く。 */
export function sanitizeBlockText(raw: unknown): string {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n");
  const cleaned: string[] = [];

  for (const originalLine of lines) {
    const trimmed = originalLine.trim();
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) continue;

    const line = originalLine
      .replace(/<\/?(?:aside|details|summary)\s*>/gi, "")
      .replace(/<\/?file(?:\s+[^>]*)?>/gi, "")
      .replace(/^(\s*)>\s?/, "$1");

    if (line.trim() === "" && trimmed !== "") continue;
    cleaned.push(line);
  }

  return cleaned.join("\n");
}

/** link ブロックとインラインリンクで許可する安全なスキーム。 */
export function safeLinkUrl(raw: unknown): string {
  const u = String(raw ?? "").trim();
  return /^(https?:\/\/|mailto:)/i.test(u) ? u : "";
}

/** 指定型の空ブロックを生成。 */
export function emptyBlock(type: BlockType): ProfileBlock {
  const id = newId();
  switch (type) {
    case "heading":
      return { id, type: "heading", text: "", level: 2 };
    case "text":
      return { id, type: "text", text: "" };
    case "list":
      return { id, type: "list", items: [{ text: "" }] };
    case "image":
      return { id, type: "image", images: [] };
    case "link":
      return { id, type: "link", url: "", title: "", description: "" };
  }
}

/**
 * 本文が箇条書きだけで構成される時に list の items へ変換する。
 * 空行以外がすべて「- 本文」で、本文が1件以上ある場合だけ成立する。
 * 先頭に2文字以上の空白がある行は直前項目の子要素（1段）として扱う。
 */
export function textToListItems(text: string): ListItem[] | null {
  const significant = sanitizeBlockText(text)
    .split("\n")
    .filter((line) => line.trim() !== "");
  if (significant.length === 0) return null;

  const parsed = significant.map((line) => line.match(/^(\s*)-\s+(.+?)\s*$/));
  if (parsed.some((match) => !match || !match[2].trim())) return null;

  const items: ListItem[] = [];
  for (const match of parsed) {
    if (!match) continue;
    const indent = match[1].replace(/\t/g, "  ").length;
    const value = sanitizeBlockText(match[2]).trim();
    if (indent >= 2 && items.length > 0) {
      const parent = items[items.length - 1];
      parent.children = [...(parent.children ?? []), value];
    } else {
      items.push({ text: value });
    }
  }
  return items.length > 0 ? items : null;
}

function normalizeListItems(raw: unknown): ListItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => ({
      text: sanitizeBlockText(item.text),
      children: Array.isArray(item.children)
        ? item.children.map(sanitizeBlockText).filter((value) => value.trim() !== "")
        : undefined,
    }));
}

/** jsonb から読んだ値を安全に ProfileBlock[] へ正規化（不正要素は捨てる）。 */
export function normalizeBlocks(raw: unknown): ProfileBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id ? rec.id : newId();
    const layout = normalizeLayout(rec.layout);
    switch (rec.type) {
      case "heading":
        out.push({
          id,
          type: "heading",
          text: sanitizeBlockText(rec.text),
          level: rec.level === 3 ? 3 : 2,
          ...(layout ? { layout } : {}),
        });
        break;
      case "text": {
        const text = sanitizeBlockText(rec.text);
        // sanitize の結果、中身が <aside> やタグだけだったブロックは空になる。
        // そのまま残すと描画側に空段落の隙間が出るので、ここで落とす。
        if (!text.trim()) break;
        const items = textToListItems(text);
        out.push(
          items
            ? { id, type: "list", items, ...(layout ? { layout } : {}) }
            : { id, type: "text", text, ...(layout ? { layout } : {}) },
        );
        break;
      }
      case "list": {
        // 空の項目は描画するとマーカーだけの行になるので、ここで捨てる。
        const items = normalizeListItems(rec.items).filter(
          (item) => item.text.trim() !== "" || item.children?.some((c) => c.trim() !== ""),
        );
        if (items.length === 0) break;
        out.push({
          id,
          type: "list",
          ordered: rec.ordered === true || undefined,
          items,
          ...(layout ? { layout } : {}),
        });
        break;
      }
      case "image": {
        const imgs = Array.isArray(rec.images) ? rec.images : [];
        out.push({
          id,
          type: "image",
          images: imgs
            .filter((im): im is Record<string, unknown> => !!im && typeof im === "object")
            .map((im) => ({
              path: String(im.path ?? ""),
              caption: im.caption ? sanitizeBlockText(im.caption) : undefined,
            }))
            .filter((im) => im.path),
          ...(layout ? { layout } : {}),
        });
        break;
      }
      case "link":
        out.push({
          id,
          type: "link",
          url: safeLinkUrl(rec.url),
          title: rec.title ? sanitizeBlockText(rec.title) : undefined,
          description: rec.description ? sanitizeBlockText(rec.description) : undefined,
          ...(layout ? { layout } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** 保存前の整形: 本文だけの箇条書きを list 化し、空ブロックを除去する。 */
export function pruneBlocks(blocks: ProfileBlock[]): ProfileBlock[] {
  return blocks
    .map((block): ProfileBlock => {
      if (block.type === "text") {
        const text = sanitizeBlockText(block.text);
        const items = textToListItems(text);
        return items ? { ...block, type: "list", items } : { ...block, text };
      }
      if (block.type === "heading") return { ...block, text: sanitizeBlockText(block.text) };
      if (block.type === "list") {
        return {
          ...block,
          items: block.items.map((item) => ({
            text: sanitizeBlockText(item.text),
            children: item.children?.map(sanitizeBlockText).filter((value) => value.trim()),
          })),
        };
      }
      if (block.type === "image") {
        return {
          ...block,
          images: block.images.map((image) => ({
            ...image,
            caption: image.caption ? sanitizeBlockText(image.caption) : undefined,
          })),
        };
      }
      return {
        ...block,
        url: safeLinkUrl(block.url),
        title: block.title ? sanitizeBlockText(block.title) : undefined,
        description: block.description ? sanitizeBlockText(block.description) : undefined,
      };
    })
    .filter((block) => {
      switch (block.type) {
        case "heading":
        case "text":
          return block.text.trim() !== "";
        case "list":
          return block.items.some(
            (item) => item.text.trim() !== "" || item.children?.some((child) => child.trim() !== ""),
          );
        case "image":
          return block.images.length > 0;
        case "link":
          return block.url.trim() !== "";
      }
    });
}

/** blocks 内の全画像 path を収集（signed URL 一括発行用）。 */
export function collectBlockImagePaths(blocks: ProfileBlock[]): string[] {
  const paths: string[] = [];
  for (const b of blocks) {
    if (b.type === "image") for (const im of b.images) if (im.path) paths.push(im.path);
  }
  return paths;
}

/** 裸URLの自動リンク化用。global フラグは付けない。 */
export const URL_REGEX = /(https?:\/\/[^\s<>"']+)/;
