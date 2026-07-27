/**
 * Centralized localStorage keys. Keep them all here so renames are a
 * one-stop change and we never accidentally split storage across two
 * subtly-different prefixes.
 */
const PREFIX = "org-chart-prototype";

export const STORAGE_KEYS = {
  /** Author display name (legacy single-field — pre app_users). */
  author: `${PREFIX}:author`,
  /** Currently signed-in user's email. Resolved against app_users. */
  currentEmail: `${PREFIX}:current-email`,
  /** Optimistic local draft of the editor nodes (recovers on reload). */
  draft: `${PREFIX}:v2`,
  /** Last server file the user had open (so a no-draft reload reopens the
   *  same file instead of jumping to the most-recently-created one). */
  lastVersionId: `${PREFIX}:last-version`,
  /** Last-used SmartHR/Google Sheet CSV URL for the employee importer. */
  sheetCsvUrl: `${PREFIX}:sheet-csv-url`,
  /** 未配置メンバーパネルの絞り込み状態（雇用形態モード・部署）。 */
  unplacedFilters: `${PREFIX}:unplaced-filters`,
} as const;

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore quota / privacy-mode errors
  }
}

/**
 * Local editor draft. Critically this records WHICH server file the draft
 * belongs to (`versionId`) so a reload restores unsaved work against the
 * correct file — not whatever was most-recently created. The old format
 * was a bare `{ nodes }` with no binding, which caused cross-file clobbering
 * and broke multi-editor sync (every reload looked "dirty" forever).
 */
export type DraftPayload = {
  v: 3;
  /** Server version id this draft overwrites, or null for an unsaved new file. */
  versionId: string | null;
  versionLabel: string | null;
  /** ISO timestamp the draft was last written — compared against the
   *  server row's updated_at to warn when someone else saved meanwhile. */
  savedAt: string;
  nodes: unknown[];
  /** 0027: 編集の元になったサーバ rev（保存時の照合に使う）。 */
  rev?: number | null;
};

export type LegacyDraft = { legacyNodes: unknown[] };

/** Returns the bound draft, a legacy (unbound) draft, or null. */
export function readDraft(): DraftPayload | LegacyDraft | null {
  const raw = readStorage(STORAGE_KEYS.draft);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (p && p.v === 3 && Array.isArray(p.nodes)) {
      return p as unknown as DraftPayload;
    }
    if (p && Array.isArray(p.nodes)) {
      // Pre-binding format: keep the nodes but treat as unbound so we never
      // silently overwrite an unrelated server file.
      return { legacyNodes: p.nodes as unknown[] };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeDraft(d: DraftPayload): void {
  writeStorage(STORAGE_KEYS.draft, JSON.stringify(d));
}

export function clearDraft(): void {
  writeStorage(STORAGE_KEYS.draft, null);
}
