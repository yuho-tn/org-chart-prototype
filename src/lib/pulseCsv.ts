/**
 * P4-④: パルス各画面の CSV エクスポート（クライアント生成）。
 * サーバ実装は増やさない — 画面に表示されているデータ（＝権限・実名マスク・
 * n<5 マスクを通過済み）だけをそのまま CSV に落とす方針。
 * Excel 互換のため UTF-8 BOM 付き・全セル quote。
 */

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // CSV/フォーミュラ・インジェクション対策: Excel が式として解釈する先頭文字
  // （= + - @ タブ CR）は ' を前置して無害化する（自由記述セルが通るため必須）。
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** headers＋rows（cell 配列）から CSV 文字列を生成。 */
export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

/** CSV をブラウザダウンロードとして保存。 */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
