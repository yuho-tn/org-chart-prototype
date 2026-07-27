import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * スプレッドシート型グリッド（人件費管理用・依存ライブラリなし）。
 *
 * Google スプレッドシートの操作感に寄せる:
 *   - クリック選択 / Shift+クリック・ドラッグで範囲選択
 *   - 矢印キー移動（Shiftで範囲拡張）・Tab/Enterで確定移動
 *   - 文字入力で即編集開始（上書き）・F2/ダブルクリックで既存値編集
 *   - Cmd/Ctrl+C・X・V: TSVコピー/カット/ペースト（Excel/スプシ互換）
 *   - Delete/Backspace: 範囲クリア
 *   - Cmd/Ctrl+D: フィルダウン
 *   - Cmd/Ctrl+Z / Shift+Cmd+Z: undo/redo（親から注入）
 */

export type GridCellValue = string | number | null;

export type GridColumn = {
  key: string;
  title: string;
  width: number;
  type: "text" | "number" | "percent" | "readonly" | "select";
  /** 2段ヘッダーの上段ラベル。連続する同名列は結合表示。 */
  group?: string;
  /** 左端固定列 */
  sticky?: boolean;
  align?: "left" | "right";
  /** text セルの入力候補（datalist）／select の選択肢 */
  options?: string[];
};

export type GridRow = {
  id: string;
  cells: Record<string, GridCellValue>;
  className?: string;
};

export type GridEdit = { rowId: string; colKey: string; value: GridCellValue };

type Props = {
  columns: GridColumn[];
  rows: GridRow[];
  onEdits: (edits: GridEdit[], label: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  /** セル単位の追加クラス（見込みハイライト等） */
  cellClassName?: (rowId: string, colKey: string) => string | undefined;
  /** 表示フォーマッタ（未指定は素通し） */
  formatCell?: (value: GridCellValue, col: GridColumn, rowId: string) => string;
};

type CellPos = { r: number; c: number };
type Rect = { r1: number; c1: number; r2: number; c2: number };

function normRect(a: CellPos, b: CellPos): Rect {
  return {
    r1: Math.min(a.r, b.r),
    c1: Math.min(a.c, b.c),
    r2: Math.max(a.r, b.r),
    c2: Math.max(a.c, b.c),
  };
}

function parseNumber(raw: string): number | null {
  const s = raw.replace(/[,¥\s万円]/g, "").trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function parsePercent(raw: string): number | null {
  const s = raw.replace(/[%\s]/g, "").trim();
  if (s === "") return null;
  let n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > 1) n = n / 100;
  return n;
}

export function parseCellInput(raw: string, col: GridColumn): GridCellValue {
  if (col.type === "number") return parseNumber(raw);
  if (col.type === "percent") return parsePercent(raw);
  const t = raw.trim();
  return t === "" ? null : t;
}

function defaultFormat(value: GridCellValue, col: GridColumn): string {
  if (value == null || value === "") return "";
  if (col.type === "percent") {
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return `${Math.round(n * 1000) / 10}%`;
  }
  if (typeof value === "number") {
    const r = Math.round(value * 10) / 10;
    return r.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  return String(value);
}

export function LaborGrid({
  columns,
  rows,
  onEdits,
  onUndo,
  onRedo,
  cellClassName,
  formatCell,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const [focus, setFocus] = useState<CellPos | null>(null);
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState<{ pos: CellPos; value: string } | null>(null);
  const datalistId = useMemo(
    () => `labor-grid-dl-${Math.floor(performance.now() * 1000) % 100000}`,
    [],
  );

  const sel: Rect | null = useMemo(() => {
    if (!focus) return null;
    return normRect(anchor ?? focus, focus);
  }, [focus, anchor]);

  // sticky 列の left オフセット
  const stickyLefts = useMemo(() => {
    const lefts: (number | undefined)[] = [];
    let acc = 0;
    for (const col of columns) {
      if (col.sticky) {
        lefts.push(acc);
        acc += col.width;
      } else {
        lefts.push(undefined);
      }
    }
    return lefts;
  }, [columns]);

  // グループヘッダー行の結合計算
  const groupSpans = useMemo(() => {
    const spans: { label: string; span: number; sticky: boolean }[] = [];
    for (const col of columns) {
      const label = col.group ?? "";
      const last = spans[spans.length - 1];
      if (last && last.label === label && !col.sticky && !last.sticky) {
        last.span += 1;
      } else {
        spans.push({ label, span: 1, sticky: !!col.sticky });
      }
    }
    return spans;
  }, [columns]);

  const clampPos = useCallback(
    (p: CellPos): CellPos => ({
      r: Math.max(0, Math.min(rows.length - 1, p.r)),
      c: Math.max(0, Math.min(columns.length - 1, p.c)),
    }),
    [rows.length, columns.length],
  );

  const commitEdit = useCallback(
    (move?: { dr: number; dc: number }, rawOverride?: string) => {
      if (!editing) return;
      const col = columns[editing.pos.c];
      const row = rows[editing.pos.r];
      if (col && row && col.type !== "readonly") {
        const raw = rawOverride !== undefined ? rawOverride : editing.value;
        const value = parseCellInput(raw, col);
        const prev = row.cells[col.key] ?? null;
        if (value !== prev) {
          onEdits([{ rowId: row.id, colKey: col.key, value }], "セル編集");
        }
      }
      setEditing(null);
      wrapRef.current?.focus();
      if (move && focus) {
        const next = clampPos({ r: focus.r + move.dr, c: focus.c + move.dc });
        setFocus(next);
        setAnchor(null);
      }
    },
    [editing, columns, rows, onEdits, focus, clampPos],
  );

  const startEdit = useCallback(
    (pos: CellPos, initial?: string) => {
      const col = columns[pos.c];
      // readonly と select（常時プルダウン描画）は編集モードに入らない
      if (!col || col.type === "readonly" || col.type === "select") return;
      const row = rows[pos.r];
      if (!row) return;
      const current = row.cells[col.key];
      const value =
        initial !== undefined
          ? initial
          : current == null
            ? ""
            : col.type === "percent"
              ? `${Math.round(Number(current) * 1000) / 10}%`
              : String(current);
      setEditing({ pos, value });
    },
    [columns, rows],
  );

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus();
      editInputRef.current?.setSelectionRange(
        editing.value.length,
        editing.value.length,
      );
    }
  }, [editing?.pos.r, editing?.pos.c]); // eslint-disable-line react-hooks/exhaustive-deps

  // 範囲 → TSV
  const selectionTsv = useCallback((): string => {
    if (!sel) return "";
    const lines: string[] = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      const row = rows[r];
      const vals: string[] = [];
      for (let c = sel.c1; c <= sel.c2; c++) {
        const col = columns[c];
        const v = row?.cells[col.key];
        if (v == null) { vals.push(""); continue; }
        if (col.type === "percent") vals.push(`${Math.round(Number(v) * 1000) / 10}%`);
        else vals.push(String(v));
      }
      lines.push(vals.join("\t"));
    }
    return lines.join("\n");
  }, [sel, rows, columns]);

  const clearSelection = useCallback(() => {
    if (!sel) return;
    const edits: GridEdit[] = [];
    for (let r = sel.r1; r <= sel.r2; r++) {
      for (let c = sel.c1; c <= sel.c2; c++) {
        const col = columns[c];
        if (col.type === "readonly") continue;
        const row = rows[r];
        if (!row) continue;
        if ((row.cells[col.key] ?? null) !== null) {
          edits.push({ rowId: row.id, colKey: col.key, value: null });
        }
      }
    }
    if (edits.length > 0) onEdits(edits, "クリア");
  }, [sel, rows, columns, onEdits]);

  const pasteTsv = useCallback(
    (text: string) => {
      if (!focus) return;
      const lines = text.replace(/\r/g, "").split("\n");
      if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      const matrix = lines.map((l) => l.split("\t"));
      if (matrix.length === 0) return;
      const base = sel ? { r: sel.r1, c: sel.c1 } : focus;
      const edits: GridEdit[] = [];
      // 単一値 × 複数選択 = 全セルに適用（スプシ挙動）
      const single = matrix.length === 1 && matrix[0].length === 1;
      if (single && sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2)) {
        for (let r = sel.r1; r <= sel.r2; r++) {
          for (let c = sel.c1; c <= sel.c2; c++) {
            const col = columns[c];
            const row = rows[r];
            if (!col || !row || col.type === "readonly") continue;
            edits.push({ rowId: row.id, colKey: col.key, value: parseCellInput(matrix[0][0], col) });
          }
        }
      } else {
        for (let i = 0; i < matrix.length; i++) {
          for (let j = 0; j < matrix[i].length; j++) {
            const r = base.r + i;
            const c = base.c + j;
            if (r >= rows.length || c >= columns.length) continue;
            const col = columns[c];
            const row = rows[r];
            if (col.type === "readonly") continue;
            edits.push({ rowId: row.id, colKey: col.key, value: parseCellInput(matrix[i][j], col) });
          }
        }
        // ペースト範囲を選択状態に
        setAnchor(base);
        setFocus(clampPos({ r: base.r + matrix.length - 1, c: base.c + Math.max(...matrix.map((m) => m.length)) - 1 }));
      }
      if (edits.length > 0) onEdits(edits, "ペースト");
    },
    [focus, sel, rows, columns, onEdits, clampPos],
  );

  const fillDown = useCallback(() => {
    if (!sel || sel.r1 === sel.r2) return;
    const edits: GridEdit[] = [];
    for (let c = sel.c1; c <= sel.c2; c++) {
      const col = columns[c];
      if (col.type === "readonly") continue;
      const src = rows[sel.r1]?.cells[col.key] ?? null;
      for (let r = sel.r1 + 1; r <= sel.r2; r++) {
        const row = rows[r];
        if (!row) continue;
        edits.push({ rowId: row.id, colKey: col.key, value: src });
      }
    }
    if (edits.length > 0) onEdits(edits, "フィルダウン");
  }, [sel, rows, columns, onEdits]);

  // ── キーボード ────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editing) return; // 編集中は input 側で処理
      if (!focus) return;
      const meta = e.metaKey || e.ctrlKey;

      const move = (dr: number, dc: number, extend: boolean) => {
        e.preventDefault();
        const next = clampPos({ r: focus.r + dr, c: focus.c + dc });
        if (extend) {
          if (!anchor) setAnchor(focus);
          setFocus(next);
        } else {
          setFocus(next);
          setAnchor(null);
        }
        scrollCellIntoView(next);
      };

      switch (e.key) {
        case "ArrowUp": move(meta ? -rows.length : -1, 0, e.shiftKey); return;
        case "ArrowDown": move(meta ? rows.length : 1, 0, e.shiftKey); return;
        case "ArrowLeft": move(0, meta ? -columns.length : -1, e.shiftKey); return;
        case "ArrowRight": move(0, meta ? columns.length : 1, e.shiftKey); return;
        case "Tab": move(0, e.shiftKey ? -1 : 1, false); return;
        case "Enter":
          e.preventDefault();
          startEdit(focus);
          return;
        case "F2":
          e.preventDefault();
          startEdit(focus);
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          clearSelection();
          return;
        case "Escape":
          setAnchor(null);
          return;
      }
      if (meta) {
        const k = e.key.toLowerCase();
        if (k === "z") {
          e.preventDefault();
          if (e.shiftKey) onRedo?.();
          else onUndo?.();
          return;
        }
        if (k === "y") { e.preventDefault(); onRedo?.(); return; }
        if (k === "d") { e.preventDefault(); fillDown(); return; }
        if (k === "a") {
          e.preventDefault();
          setAnchor({ r: 0, c: 0 });
          setFocus({ r: rows.length - 1, c: columns.length - 1 });
          return;
        }
        return; // c/x/v はネイティブイベントで処理
      }
      // 印字可能文字 → 即編集開始（上書き）
      if (e.key.length === 1 && !e.altKey) {
        e.preventDefault();
        startEdit(focus, e.key);
      }
    },
    [editing, focus, anchor, rows.length, columns.length, clampPos, startEdit, clearSelection, fillDown, onUndo, onRedo],
  );

  const scrollCellIntoView = (pos: CellPos) => {
    const el = wrapRef.current?.querySelector<HTMLElement>(
      `[data-cell="${pos.r}-${pos.c}"]`,
    );
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  // ── クリップボード（ネイティブイベント） ──────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const onCopy = (e: ClipboardEvent) => {
      if (editing) return;
      if (!wrap.contains(document.activeElement)) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selectionTsv());
    };
    const onCut = (e: ClipboardEvent) => {
      if (editing) return;
      if (!wrap.contains(document.activeElement)) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", selectionTsv());
      clearSelection();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (editing) return;
      if (!wrap.contains(document.activeElement)) return;
      const text = e.clipboardData?.getData("text/plain");
      if (text == null) return;
      e.preventDefault();
      pasteTsv(text);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [selectionTsv, pasteTsv, clearSelection, editing]);

  // ── マウス ────────────────────────────────────────────────────────
  const onCellMouseDown = (r: number, c: number, e: React.MouseEvent) => {
    if (editing) commitEdit();
    if (e.shiftKey && focus) {
      setAnchor(anchor ?? focus);
      setFocus({ r, c });
    } else {
      setFocus({ r, c });
      setAnchor(null);
      setDragging(true);
    }
    wrapRef.current?.focus();
    e.preventDefault();
  };
  const onCellMouseEnter = (r: number, c: number) => {
    if (!dragging || !focus) return;
    if (!anchor) setAnchor(focus);
    setFocus({ r, c });
  };
  useEffect(() => {
    const up = () => setDragging(false);
    document.addEventListener("mouseup", up);
    return () => document.removeEventListener("mouseup", up);
  }, []);

  const inSelection = (r: number, c: number): boolean =>
    !!sel && r >= sel.r1 && r <= sel.r2 && c >= sel.c1 && c <= sel.c2;

  const isFocus = (r: number, c: number): boolean =>
    !!focus && focus.r === r && focus.c === c;

  const editCol = editing ? columns[editing.pos.c] : null;

  return (
    <div
      ref={wrapRef}
      className="lg-wrap"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <table
        className="lg-table"
        style={{ width: columns.reduce((s, c) => s + c.width, 0) }}
      >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} style={{ width: c.width, minWidth: c.width }} />
          ))}
        </colgroup>
        <thead>
          <tr className="lg-group-row">
            {(() => {
              let ci = 0;
              return groupSpans.map((g, i) => {
                const left = stickyLefts[ci];
                const cell = (
                  <th
                    key={i}
                    colSpan={g.span}
                    className={g.sticky ? "lg-sticky" : undefined}
                    style={g.sticky ? { left } : undefined}
                  >
                    {g.label}
                  </th>
                );
                ci += g.span;
                return cell;
              });
            })()}
          </tr>
          <tr>
            {columns.map((col, c) => (
              <th
                key={col.key}
                className={[
                  col.sticky ? "lg-sticky" : "",
                  col.type === "readonly" ? "lg-col-ro" : "",
                ].filter(Boolean).join(" ") || undefined}
                style={col.sticky ? { left: stickyLefts[c] } : undefined}
              >
                {col.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={row.id} className={row.className}>
              {columns.map((col, c) => {
                const isEditingCell =
                  editing && editing.pos.r === r && editing.pos.c === c;
                const v = row.cells[col.key] ?? null;
                const text = formatCell
                  ? formatCell(v, col, row.id)
                  : defaultFormat(v, col);
                const cls = [
                  "lg-cell",
                  col.sticky ? "lg-sticky" : "",
                  col.type === "readonly" ? "lg-ro" : "",
                  col.align === "right" || col.type === "number" || col.type === "percent"
                    ? "lg-num" : "",
                  inSelection(r, c) ? "lg-sel" : "",
                  isFocus(r, c) ? "lg-focus" : "",
                  cellClassName?.(row.id, col.key) ?? "",
                ].filter(Boolean).join(" ");
                return (
                  <td
                    key={col.key}
                    data-cell={`${r}-${c}`}
                    className={cls}
                    style={col.sticky ? { left: stickyLefts[c] } : undefined}
                    onMouseDown={(e) => onCellMouseDown(r, c, e)}
                    onMouseEnter={() => onCellMouseEnter(r, c)}
                    onDoubleClick={() => startEdit({ r, c })}
                  >
                    {col.type === "select" ? (
                      <select
                        className="lg-cellselect"
                        value={(typeof v === "string" ? v : "") || ""}
                        onMouseDown={(e) => e.stopPropagation()}
                        onChange={(e) =>
                          onEdits(
                            [{ rowId: row.id, colKey: col.key, value: e.target.value || null }],
                            "所属選択",
                          )
                        }
                      >
                        <option value="">（未設定）</option>
                        {(col.options ?? []).map((o) => (
                          <option key={o} value={o}>{o}</option>
                        ))}
                      </select>
                    ) : isEditingCell ? (
                      <input
                        ref={editInputRef}
                        className="lg-edit"
                        value={editing.value}
                        list={editCol?.options ? datalistId : undefined}
                        onChange={(e) =>
                          setEditing((s) => (s ? { ...s, value: e.target.value } : s))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit({ dr: 1, dc: 0 });
                          } else if (e.key === "Tab") {
                            e.preventDefault();
                            commitEdit({ dr: 0, dc: e.shiftKey ? -1 : 1 });
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                            wrapRef.current?.focus();
                          }
                          e.stopPropagation();
                        }}
                        onBlur={() => commitEdit()}
                      />
                    ) : (
                      text
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {(() => {
        const opts = editCol?.options;
        return opts ? (
          <datalist id={datalistId}>
            {opts.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        ) : null;
      })()}
    </div>
  );
}
