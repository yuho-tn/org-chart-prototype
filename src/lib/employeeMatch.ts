import type { EmployeeRow } from "./supabase";

/**
 * Normalize a chip name / employee full_name for fuzzy-equal comparison.
 * The names that show up on chips often differ from the master in cosmetic
 * ways:
 *   - leading "*" prefix marking 兼務 entries
 *   - full-width "　" or repeated spaces around the family/given separator
 *   - leading/trailing whitespace from CSV imports
 * Normalizing both sides through the same filter lets us match exact-text
 * pairs without false negatives, while still requiring a real character
 * match (not a substring fuzz).
 */
export function normalizeName(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .trim()
    .replace(/^\*+/, "")
    // Collapse all whitespace (including the full-width 　) to a single space.
    .replace(/[\s　]+/g, " ")
    .toLowerCase();
}

/**
 * Find the single employee whose full_name normalizes to the same string as
 * `name`. Returns null when there are 0 matches OR multiple matches —
 * ambiguous matches must NOT be auto-linked because we can't tell which
 * person the user meant. Callers can fall back to a manual picker in that
 * case.
 */
export function findEmployeeByName(
  name: string,
  employees: EmployeeRow[],
): EmployeeRow | null {
  const target = normalizeName(name);
  if (!target) return null;
  let hit: EmployeeRow | null = null;
  let count = 0;
  for (const e of employees) {
    if (normalizeName(e.full_name) === target) {
      count += 1;
      if (count > 1) return null;
      hit = e;
    }
  }
  return hit;
}
