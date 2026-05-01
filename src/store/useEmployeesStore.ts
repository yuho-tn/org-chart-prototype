import { create } from "zustand";
import { supabase, type EmployeeRow } from "../lib/supabase";
import { parseCsv, pick, normalizeDate } from "../lib/csv";

const SHEET_URL_KEY = "org-chart-prototype:sheet-csv-url";

/**
 * Header synonyms accepted in CSV imports. The first hit wins.
 * SmartHR / Google Sheets templates vary slightly, so we cast a wide net.
 */
const HEADER_MAP = {
  employee_number: ["社員番号", "従業員番号", "ID", "employee_number"],
  last_name: ["姓", "苗字", "氏", "last_name"],
  first_name: ["名", "下の名前", "first_name"],
  email: ["メールアドレス", "メール", "email", "Email", "Mail"],
  employment_type: ["雇用形態", "雇用区分", "employment_type"],
  department: ["部署", "所属部署", "department", "部門"],
  position_title: ["役職", "役職名", "position", "title", "position_title"],
  hired_at: ["入社日", "hire_date", "入社年月日"],
  left_at: ["退職日", "leave_date", "退職年月日", "退社日"],
} as const;

export type ImportSummary = {
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
};

type EmployeesState = {
  employees: EmployeeRow[];
  loading: boolean;
  error: string | null;
  /** Optional published-CSV URL (Google Sheets "Publish to web" output). */
  sheetCsvUrl: string;

  refresh: () => Promise<void>;
  /** Insert or upsert one employee record. */
  upsert: (row: Partial<EmployeeRow> & { employee_number: string }) => Promise<{ ok: boolean; reason?: string }>;
  remove: (employeeNumber: string) => Promise<boolean>;
  /** Bulk import from CSV text. Existing rows match by employee_number. */
  importCsv: (csvText: string) => Promise<ImportSummary>;
  /** Fetch CSV from a published Google Sheets URL and import it. */
  importFromSheetUrl: (url: string) => Promise<ImportSummary>;
  setSheetCsvUrl: (url: string) => void;
};

function readStoredUrl(): string {
  try {
    return localStorage.getItem(SHEET_URL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredUrl(url: string) {
  try {
    if (url) localStorage.setItem(SHEET_URL_KEY, url);
    else localStorage.removeItem(SHEET_URL_KEY);
  } catch {
    // ignore
  }
}

/** Map a parsed CSV row to a partial EmployeeRow keyed by canonical column name. */
function csvRowToEmployee(row: Record<string, string>): Partial<EmployeeRow> & {
  employee_number: string;
} | null {
  const num = pick(row, [...HEADER_MAP.employee_number]);
  if (!num) return null;
  return {
    employee_number: num,
    last_name: pick(row, [...HEADER_MAP.last_name]) || null,
    first_name: pick(row, [...HEADER_MAP.first_name]) || null,
    email: pick(row, [...HEADER_MAP.email]).toLowerCase() || null,
    employment_type: pick(row, [...HEADER_MAP.employment_type]) || null,
    department: pick(row, [...HEADER_MAP.department]) || null,
    position_title: pick(row, [...HEADER_MAP.position_title]) || null,
    hired_at: normalizeDate(pick(row, [...HEADER_MAP.hired_at])),
    left_at: normalizeDate(pick(row, [...HEADER_MAP.left_at])),
  };
}

export const useEmployeesStore = create<EmployeesState>((set, get) => ({
  employees: [],
  loading: false,
  error: null,
  sheetCsvUrl: readStoredUrl(),

  refresh: async () => {
    if (!supabase) return;
    set({ loading: true, error: null });
    const { data, error } = await supabase
      .from("employees")
      .select("*")
      .order("hired_at", { ascending: false, nullsFirst: false });
    if (error) {
      const isMissing = /relation .*employees.* does not exist/i.test(error.message);
      set({
        loading: false,
        error: isMissing
          ? "従業員テーブルが見つかりません。supabase/migrations/0002_employees.sql をSQLエディタで実行してください。"
          : error.message,
        employees: [],
      });
      return;
    }
    set({ loading: false, employees: (data ?? []) as EmployeeRow[], error: null });
  },

  upsert: async (row) => {
    if (!supabase) return { ok: false, reason: "Supabase未設定です" };
    if (!row.employee_number.trim()) {
      return { ok: false, reason: "社員番号は必須です" };
    }
    const { error } = await supabase
      .from("employees")
      .upsert(row, { onConflict: "employee_number" });
    if (error) return { ok: false, reason: error.message };
    await get().refresh();
    return { ok: true };
  },

  remove: async (employeeNumber) => {
    if (!supabase) return false;
    const { error } = await supabase
      .from("employees")
      .delete()
      .eq("employee_number", employeeNumber);
    if (error) {
      set({ error: error.message });
      return false;
    }
    set({
      employees: get().employees.filter((e) => e.employee_number !== employeeNumber),
    });
    return true;
  },

  importCsv: async (csvText) => {
    const summary: ImportSummary = {
      totalRows: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };
    if (!supabase) {
      summary.errors.push("Supabase未設定です");
      return summary;
    }
    const { rows } = parseCsv(csvText);
    summary.totalRows = rows.length;
    if (rows.length === 0) {
      summary.errors.push("CSVに行が含まれていません（ヘッダー行のみ／空ファイル）");
      return summary;
    }

    // Pre-compute existing keys for "inserted vs updated" reporting.
    const existing = new Set(get().employees.map((e) => e.employee_number));

    const payload: (Partial<EmployeeRow> & { employee_number: string })[] = [];
    for (const row of rows) {
      const mapped = csvRowToEmployee(row);
      if (!mapped) {
        summary.skipped += 1;
        summary.errors.push(`社員番号が空の行をスキップしました: ${JSON.stringify(row).slice(0, 80)}`);
        continue;
      }
      payload.push(mapped);
    }
    if (payload.length === 0) return summary;

    // Upsert in chunks of 200 to stay well under request size limits.
    const CHUNK = 200;
    for (let i = 0; i < payload.length; i += CHUNK) {
      const slice = payload.slice(i, i + CHUNK);
      const { error } = await supabase
        .from("employees")
        .upsert(slice, { onConflict: "employee_number" });
      if (error) {
        summary.errors.push(`バッチ ${i}-${i + slice.length} で失敗: ${error.message}`);
        continue;
      }
      for (const r of slice) {
        if (existing.has(r.employee_number)) summary.updated += 1;
        else {
          summary.inserted += 1;
          existing.add(r.employee_number);
        }
      }
    }
    await get().refresh();
    return summary;
  },

  importFromSheetUrl: async (url) => {
    const summary: ImportSummary = {
      totalRows: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) {
        summary.errors.push(`スプレッドシートの取得に失敗（HTTP ${res.status}）。「ウェブに公開」されたCSV URLか確認してください。`);
        return summary;
      }
      const text = await res.text();
      // Sniff for HTML response (means the URL isn't a CSV — likely the wrong URL).
      if (text.startsWith("<!DOCTYPE") || text.startsWith("<html")) {
        summary.errors.push(
          "取得したのがHTMLでした。Google Sheetsで「ファイル > 共有 > ウェブに公開」を行い、対象タブをCSV形式で公開した URL を貼り付けてください。",
        );
        return summary;
      }
      return await get().importCsv(text);
    } catch (e) {
      summary.errors.push(`通信エラー: ${(e as Error).message}`);
      return summary;
    }
  },

  setSheetCsvUrl: (url) => {
    writeStoredUrl(url);
    set({ sheetCsvUrl: url });
  },
}));

/** Filter helper: returns active employees (left_at is null or in the future). */
export function activeEmployees(rows: EmployeeRow[]): EmployeeRow[] {
  const today = new Date().toISOString().slice(0, 10);
  return rows.filter((e) => !e.left_at || e.left_at > today);
}
