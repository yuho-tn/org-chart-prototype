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
  /** Last-used SmartHR/Google Sheet CSV URL for the employee importer. */
  sheetCsvUrl: `${PREFIX}:sheet-csv-url`,
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
