/**
 * P3: 自由プロフィールの軽量自作ブロックエディタ（外部ライブラリ不採用）。
 * 4型: heading / text / image / link。employee_profiles.blocks(jsonb) に
 * 構造化データのみ保存（HTMLは保存しない＝XSS安全）。冒頭の自己紹介も
 * この同じ機構で表現する（専用実装を分けない）。
 */

export type BlockBase = { id: string };

/** 見出し。 */
export type HeadingBlock = BlockBase & { type: "heading"; text: string };

/** 本文（改行可・表示時に URL 自動リンク化）。 */
export type TextBlock = BlockBase & { type: "text"; text: string };

/** 画像（複数枚ギャラリー・キャプション）。path は profile-photos バケット内。 */
export type ImageBlock = BlockBase & {
  type: "image";
  images: { path: string; caption?: string }[];
};

/** リンクカード（URL＋タイトル＋説明）。 */
export type LinkBlock = BlockBase & {
  type: "link";
  url: string;
  title?: string;
  description?: string;
};

export type ProfileBlock = HeadingBlock | TextBlock | ImageBlock | LinkBlock;

export type BlockType = ProfileBlock["type"];

export const BLOCK_TYPE_LABEL: Record<BlockType, string> = {
  heading: "見出し",
  text: "テキスト",
  image: "画像",
  link: "リンク",
};

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 指定型の空ブロックを生成。 */
export function emptyBlock(type: BlockType): ProfileBlock {
  const id = newId();
  switch (type) {
    case "heading":
      return { id, type: "heading", text: "" };
    case "text":
      return { id, type: "text", text: "" };
    case "image":
      return { id, type: "image", images: [] };
    case "link":
      return { id, type: "link", url: "", title: "", description: "" };
  }
}

/** jsonb から読んだ値を安全に ProfileBlock[] へ正規化（不正要素は捨てる）。 */
export function normalizeBlocks(raw: unknown): ProfileBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ProfileBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== "object") continue;
    const rec = b as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id ? rec.id : newId();
    switch (rec.type) {
      case "heading":
        out.push({ id, type: "heading", text: String(rec.text ?? "") });
        break;
      case "text":
        out.push({ id, type: "text", text: String(rec.text ?? "") });
        break;
      case "image": {
        const imgs = Array.isArray(rec.images) ? rec.images : [];
        out.push({
          id,
          type: "image",
          images: imgs
            .filter((im): im is Record<string, unknown> => !!im && typeof im === "object")
            .map((im) => ({
              path: String(im.path ?? ""),
              caption: im.caption ? String(im.caption) : undefined,
            }))
            .filter((im) => im.path),
        });
        break;
      }
      case "link":
        out.push({
          id,
          type: "link",
          url: String(rec.url ?? ""),
          title: rec.title ? String(rec.title) : undefined,
          description: rec.description ? String(rec.description) : undefined,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** 空ブロック（内容が空）を保存前に除去する。 */
export function pruneBlocks(blocks: ProfileBlock[]): ProfileBlock[] {
  return blocks.filter((b) => {
    switch (b.type) {
      case "heading":
      case "text":
        return b.text.trim() !== "";
      case "image":
        return b.images.length > 0;
      case "link":
        return b.url.trim() !== "";
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

/** URL らしき文字列にマッチ（text ブロックの自動リンク化用）。 */
export const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g;
