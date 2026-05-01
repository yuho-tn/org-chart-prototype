/**
 * Minimal CSV parser sized for our use case (employee master imports).
 * Handles: quoted fields, embedded commas inside quotes, escaped quotes ("").
 * Does NOT handle: line breaks inside quoted cells (very rare for HR data).
 *
 * The first non-empty row is treated as the header. Returns an array of
 * row objects keyed by the header name; missing columns are undefined.
 */
export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  // Strip BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === ",") {
          out.push(cur);
          cur = "";
        } else if (c === '"') {
          inQuotes = true;
        } else {
          cur += c;
        }
      }
    }
    out.push(cur);
    return out;
  };

  const headers = parseLine(lines[0]).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = (cells[idx] ?? "").trim();
    });
    rows.push(row);
  }
  return { headers, rows };
}

/**
 * Pull the first non-empty value found under any of the candidate header names.
 * SmartHR exports use slightly different conventions across tenants, so we try
 * a few synonyms before giving up.
 */
export function pick(row: Record<string, string>, candidates: string[]): string {
  for (const c of candidates) {
    const v = row[c];
    if (v !== undefined && v !== "") return v;
  }
  return "";
}

/** Normalize Japanese / Excel date strings into ISO yyyy-mm-dd, or null. */
export function normalizeDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // ISO already?
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // 2025/03/05  /  2025/3/5
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (slash) {
    const [, y, m, d] = slash;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // 2025年3月5日
  const jp = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/.exec(s);
  if (jp) {
    const [, y, m, d] = jp;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Fallback: let JS try; if NaN, give up.
  const t = Date.parse(s);
  if (!isNaN(t)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return null;
}
