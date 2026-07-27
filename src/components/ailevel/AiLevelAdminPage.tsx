import { useEffect, useMemo, useState } from "react";
import { useEmployeesStore, activeEmployees } from "../../store/useEmployeesStore";
import { useAiLevelsStore, type BulkEntry } from "../../store/useAiLevelsStore";
import { useAuthStore } from "../../store/useAuthStore";
import { employeeName, canManagePermissions } from "../../lib/supabase";
import {
  AI_LEVELS,
  AI_LEVEL_KIND_LABEL,
  aiLevelDef,
  type AiLevelKind,
} from "../../lib/aiLevels";
import { AiLevelBadge } from "./AiLevelBadge";
import { AiLevelSubnav } from "./AiLevelSubnav";

/**
 * AI活用レベル 認定管理（#/ailevel/admin・管理者のみ）。
 *   - 個別付与フォーム（社員選択・レベル・仮/本・認定日・メモ）
 *   - 一括投入（「employee_number,level」貼り付け→プレビュー→登録。
 *     初回仮認定のシート取込用）
 *   - 付与履歴一覧（誤登録行の削除可）
 * 書込みは RLS 側でも管理者限定（migration 0033）— UI ゲートは利便のため。
 */

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

type BulkPreviewRow = {
  line: number;
  raw: string;
  entry?: BulkEntry & { name: string };
  error?: string;
  /** 登録は可能だが注意が必要な行（既に同レベル以上・退職者への付与等）。 */
  warn?: string;
};

/** 一括投入の区切り文字: 半角カンマ / タブ / 読点 / 全角カンマ。 */
const BULK_SEPARATOR = /[,\t、，]/;

export function AiLevelAdminPage() {
  const role = useAuthStore((s) => s.currentUser?.role);
  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const grants = useAiLevelsStore((s) => s.grants);
  const levelOf = useAiLevelsStore((s) => s.levelByEmployee);
  const loaded = useAiLevelsStore((s) => s.loaded);
  const loading = useAiLevelsStore((s) => s.loading);
  const missing = useAiLevelsStore((s) => s.missing);
  const error = useAiLevelsStore((s) => s.error);
  const saving = useAiLevelsStore((s) => s.saving);
  const refresh = useAiLevelsStore((s) => s.refresh);
  const addGrant = useAiLevelsStore((s) => s.addGrant);
  const removeGrant = useAiLevelsStore((s) => s.removeGrant);
  const bulkImport = useAiLevelsStore((s) => s.bulkImport);

  const isAdmin = canManagePermissions(role);

  // ── 個別付与フォーム ────────────────────────────────────────────
  const [empInput, setEmpInput] = useState("");
  const [level, setLevel] = useState(1);
  const [kind, setKind] = useState<AiLevelKind>("provisional");
  const [certifiedAt, setCertifiedAt] = useState(todayStr());
  const [note, setNote] = useState("");
  const [formMsg, setFormMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 一括投入 ───────────────────────────────────────────────────
  const [bulkText, setBulkText] = useState("");
  const [bulkKind, setBulkKind] = useState<AiLevelKind>("provisional");
  const [bulkDate, setBulkDate] = useState(todayStr());
  const [bulkPreview, setBulkPreview] = useState<BulkPreviewRow[] | null>(null);
  const [bulkMsg, setBulkMsg] = useState<string | null>(null);

  // ── 履歴 ───────────────────────────────────────────────────────
  const [historyFilter, setHistoryFilter] = useState("");

  useEffect(() => {
    if (!isAdmin) return;
    if (employees.length === 0) refreshEmployees();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  const active = useMemo(() => activeEmployees(employees), [employees]);
  const empByNumber = useMemo(
    () => new Map(employees.map((e) => [e.employee_number, e])),
    [employees],
  );

  // datalist 用「社員番号 — 氏名」候補。入力からは先頭の社員番号を取り出す。
  const empOptions = useMemo(
    () =>
      active
        .map((e) => ({ num: e.employee_number, label: `${e.employee_number} — ${employeeName(e)}` }))
        .sort((a, b) => a.num.localeCompare(b.num)),
    [active],
  );

  function resolveEmpNumber(input: string): string | null {
    const raw = input.trim();
    if (!raw) return null;
    const head = raw.split("—")[0]?.trim() ?? raw;
    if (empByNumber.has(head)) return head;
    if (empByNumber.has(raw)) return raw;
    // 氏名一致（完全一致のみ・曖昧一致は誤付与リスクがあるため不可）
    const byName = active.filter((e) => employeeName(e) === raw);
    if (byName.length === 1) return byName[0].employee_number;
    return null;
  }

  async function onAdd() {
    setFormMsg(null);
    const num = resolveEmpNumber(empInput);
    if (!num) {
      setFormMsg({ ok: false, text: "社員が特定できません。候補から「社員番号 — 氏名」を選択してください。" });
      return;
    }
    const res = await addGrant({
      employee_number: num,
      level,
      kind,
      certified_at: certifiedAt,
      note,
    });
    if (res.ok) {
      const emp = empByNumber.get(num);
      setFormMsg({
        ok: true,
        text: `${emp ? employeeName(emp) : num} に L${level} ${aiLevelDef(level)?.code ?? ""}（${AI_LEVEL_KIND_LABEL[kind]}）を付与しました。`,
      });
      setEmpInput("");
      setNote("");
    } else {
      setFormMsg({ ok: false, text: res.reason ?? "付与に失敗しました" });
    }
  }

  function onBulkPreview() {
    setBulkMsg(null);
    const today = todayStr();
    const lines = bulkText
      .split(/\r?\n/)
      .map((l, i) => ({ line: i + 1, raw: l.trim() }))
      .filter((l) => l.raw !== "");
    const seen = new Set<string>();
    const rows: BulkPreviewRow[] = lines.map(({ line, raw }) => {
      const parts = raw.split(BULK_SEPARATOR).map((p) => p.trim());
      if (parts.length < 2) {
        return { line, raw, error: "「employee_number,level」形式ではありません" };
      }
      const [num, levelStr] = parts;
      const lv = Number(levelStr.replace(/^[LlＬ]/, ""));
      if (!Number.isInteger(lv) || lv < 1 || lv > 7) {
        return { line, raw, error: `レベルが不正です（1〜7）: ${levelStr}` };
      }
      const emp = empByNumber.get(num);
      if (!emp) {
        return { line, raw, error: `社員番号 ${num} が従業員マスターに見つかりません` };
      }
      if (seen.has(num)) {
        return { line, raw, error: `社員番号 ${num} が重複しています` };
      }
      seen.add(num);
      // 警告（登録は可能）: 既存の現在レベル以下 / 退職者への付与。
      const warns: string[] = [];
      const cur = levelOf.get(num);
      if (cur && cur.level >= lv) {
        warns.push(`既に同レベル以上の認定あり（現在 L${cur.level}）`);
      }
      // マスターの在籍判定（activeEmployees と同じ: left_at 無し or 未来日）
      if (emp.left_at && emp.left_at <= today) {
        warns.push(`退職者です（退職日 ${emp.left_at}）`);
      }
      return {
        line,
        raw,
        entry: { employee_number: num, level: lv, name: employeeName(emp) },
        warn: warns.length > 0 ? warns.join(" / ") : undefined,
      };
    });
    setBulkPreview(rows);
    if (rows.length === 0) setBulkMsg("投入対象の行がありません。");
  }

  async function onBulkCommit() {
    if (!bulkPreview) return;
    const entries = bulkPreview
      .filter((r) => r.entry)
      .map((r) => ({ employee_number: r.entry!.employee_number, level: r.entry!.level }));
    if (entries.length === 0) {
      setBulkMsg("有効な行がありません。");
      return;
    }
    const summary = await bulkImport(entries, { kind: bulkKind, certified_at: bulkDate });
    const skippedNote =
      summary.skipped > 0 ? `／重複スキップ ${summary.skipped}件` : "";
    if (summary.errors.length > 0) {
      setBulkMsg(`登録 ${summary.inserted}件${skippedNote}／エラー: ${summary.errors.join(" / ")}`);
    } else {
      setBulkMsg(
        `${summary.inserted}件を一括登録しました${skippedNote}（${AI_LEVEL_KIND_LABEL[bulkKind]}・認定日 ${bulkDate}）。`,
      );
      setBulkText("");
      setBulkPreview(null);
    }
  }

  async function onRemove(id: string, label: string) {
    if (!window.confirm(`この付与履歴を削除しますか？\n${label}\n（誤登録の取り消し用。現在レベルは残りの履歴から再計算されます）`)) {
      return;
    }
    const res = await removeGrant(id);
    if (!res.ok) window.alert(res.reason ?? "削除に失敗しました");
  }

  const filteredGrants = useMemo(() => {
    const q = historyFilter.trim().toLowerCase();
    if (!q) return grants;
    return grants.filter((g) => {
      const emp = empByNumber.get(g.employee_number);
      const name = emp ? employeeName(emp) : "";
      return (
        g.employee_number.toLowerCase().includes(q) ||
        name.toLowerCase().includes(q)
      );
    });
  }, [grants, historyFilter, empByNumber]);

  if (!isAdmin) {
    return (
      <main className="page ail">
        <AiLevelSubnav active="admin" />
        <p className="pdash__error">認定管理は管理者（master / 特権管理者）のみ利用できます。</p>
      </main>
    );
  }

  const validBulkCount = bulkPreview?.filter((r) => r.entry).length ?? 0;
  const errorBulkCount = bulkPreview?.filter((r) => r.error).length ?? 0;
  const warnBulkCount = bulkPreview?.filter((r) => r.warn).length ?? 0;

  return (
    <main className="page ail">
      <AiLevelSubnav active="admin" />
      <header className="page__header ail__header">
        <h1 className="page__title">AIレベル 認定管理</h1>
        <p className="page__subtitle">
          認定の付与（仮認定／本認定）と履歴の管理。レベルは失効なし＝現在レベルは履歴の最高レベルで決まります。
        </p>
      </header>

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}
      {loaded && missing && (
        <p className="ail__notice">
          AIレベル認定テーブルが未適用です。supabase/migrations/0033_ai_levels.sql を SQL Editor で適用してください。
        </p>
      )}

      {/* ── 個別付与 ─────────────────────────────────────────────── */}
      <section className="pdash__panel">
        <h2 className="pdash__h2">個別付与</h2>
        <div className="ail__form">
          <label className="ail__field ail__field--wide">
            <span className="ail__fieldLabel">社員</span>
            <input
              className="ail__input"
              list="ail-emp-options"
              value={empInput}
              onChange={(e) => setEmpInput(e.target.value)}
              placeholder="社員番号または氏名で検索"
            />
            <datalist id="ail-emp-options">
              {empOptions.map((o) => (
                <option key={o.num} value={o.label} />
              ))}
            </datalist>
          </label>
          <label className="ail__field">
            <span className="ail__fieldLabel">レベル</span>
            <select
              className="ail__input"
              value={level}
              onChange={(e) => setLevel(Number(e.target.value))}
            >
              {AI_LEVELS.map((d) => (
                <option key={d.level} value={d.level}>
                  L{d.level} {d.code}（{d.subcopy}）
                </option>
              ))}
            </select>
          </label>
          <label className="ail__field">
            <span className="ail__fieldLabel">認定種別</span>
            <select
              className="ail__input"
              value={kind}
              onChange={(e) => setKind(e.target.value as AiLevelKind)}
            >
              <option value="provisional">仮認定</option>
              <option value="official">本認定</option>
            </select>
          </label>
          <label className="ail__field">
            <span className="ail__fieldLabel">認定日</span>
            <input
              className="ail__input"
              type="date"
              value={certifiedAt}
              onChange={(e) => setCertifiedAt(e.target.value)}
            />
          </label>
          <label className="ail__field ail__field--wide">
            <span className="ail__fieldLabel">メモ（任意）</span>
            <input
              className="ail__input"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="管理者のみ閲覧。認定根拠メモ等"
            />
          </label>
          <div className="ail__field ail__field--actions">
            <button
              className="btn btn--primary"
              onClick={onAdd}
              disabled={saving || missing}
            >
              {saving ? "登録中…" : "付与する"}
            </button>
          </div>
        </div>
        {formMsg && (
          <p className={formMsg.ok ? "ail__msgOk" : "pdash__error"}>{formMsg.text}</p>
        )}
      </section>

      {/* ── 一括投入 ─────────────────────────────────────────────── */}
      <section className="pdash__panel">
        <h2 className="pdash__h2">一括投入（初回仮認定のシート取込用）</h2>
        <p className="ail__note">
          1行1名で「employee_number,level」を貼り付け →「プレビュー」で従業員マスターと突合 →「一括登録」。認定種別・認定日は下の設定が全行に適用されます。
        </p>
        <textarea
          className="ail__textarea"
          rows={6}
          value={bulkText}
          onChange={(e) => {
            setBulkText(e.target.value);
            setBulkPreview(null);
            setBulkMsg(null);
          }}
          placeholder={"例:\n1001,2\n1002,4\n1003,1"}
        />
        <div className="ail__form">
          <label className="ail__field">
            <span className="ail__fieldLabel">認定種別（全行）</span>
            <select
              className="ail__input"
              value={bulkKind}
              onChange={(e) => setBulkKind(e.target.value as AiLevelKind)}
            >
              <option value="provisional">仮認定</option>
              <option value="official">本認定</option>
            </select>
          </label>
          <label className="ail__field">
            <span className="ail__fieldLabel">認定日（全行）</span>
            <input
              className="ail__input"
              type="date"
              value={bulkDate}
              onChange={(e) => setBulkDate(e.target.value)}
            />
          </label>
          <div className="ail__field ail__field--actions">
            <button className="btn btn--ghost" onClick={onBulkPreview} disabled={!bulkText.trim()}>
              プレビュー
            </button>
            <button
              className="btn btn--primary"
              onClick={onBulkCommit}
              disabled={saving || missing || !bulkPreview || validBulkCount === 0}
            >
              {saving ? "登録中…" : `一括登録（${validBulkCount}件）`}
            </button>
          </div>
        </div>
        {bulkMsg && <p className="ail__msgOk">{bulkMsg}</p>}
        {bulkPreview && bulkPreview.length > 0 && (
          <div className="ail__tableWrap">
            <p className="ail__note">
              有効 {validBulkCount}件
              {warnBulkCount > 0 && ` ／ 警告 ${warnBulkCount}件（登録は可能）`}
              {errorBulkCount > 0 && ` ／ エラー ${errorBulkCount}件（エラー行はスキップされます）`}
            </p>
            <table className="empmgr__table ail__table">
              <thead>
                <tr>
                  <th>行</th>
                  <th>社員番号</th>
                  <th>氏名</th>
                  <th>レベル</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {bulkPreview.map((r) => (
                  <tr
                    key={r.line}
                    className={
                      r.error ? "ail__rowError" : r.warn ? "ail__rowWarn" : undefined
                    }
                  >
                    <td>{r.line}</td>
                    <td>{r.entry?.employee_number ?? r.raw.split(BULK_SEPARATOR)[0]}</td>
                    <td>{r.entry?.name ?? "—"}</td>
                    <td>
                      {r.entry ? <AiLevelBadge level={r.entry.level} size="sm" /> : "—"}
                    </td>
                    <td>
                      {r.error ? (
                        <span className="ail__err">{r.error}</span>
                      ) : r.warn ? (
                        <span className="ail__warn">⚠ {r.warn}</span>
                      ) : (
                        "OK"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── 付与履歴 ─────────────────────────────────────────────── */}
      <section className="pdash__panel">
        <h2 className="pdash__h2">付与履歴（{grants.length}件）</h2>
        <input
          className="ail__input ail__historySearch"
          value={historyFilter}
          onChange={(e) => setHistoryFilter(e.target.value)}
          placeholder="社員番号・氏名で絞り込み"
        />
        {filteredGrants.length === 0 ? (
          <p className="pdash__muted">
            {grants.length === 0 ? "付与履歴はまだありません。" : "条件に一致する履歴がありません。"}
          </p>
        ) : (
          <div className="ail__tableWrap">
            <table className="empmgr__table ail__table">
              <thead>
                <tr>
                  <th>社員番号</th>
                  <th>氏名</th>
                  <th>レベル</th>
                  <th>種別</th>
                  <th>認定日</th>
                  <th>メモ</th>
                  <th>登録者</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredGrants.map((g) => {
                  const emp = empByNumber.get(g.employee_number);
                  const name = emp ? employeeName(emp) : "（マスター未登録）";
                  return (
                    <tr key={g.id}>
                      <td>{g.employee_number}</td>
                      <td>{name}</td>
                      <td>
                        <AiLevelBadge level={g.level} size="sm" />
                      </td>
                      <td>{AI_LEVEL_KIND_LABEL[g.kind]}</td>
                      <td>{g.certified_at}</td>
                      <td className="ail__noteCell">{g.note ?? ""}</td>
                      <td className="ail__noteCell">{g.created_by ?? ""}</td>
                      <td>
                        <button
                          className="btn btn--ghost btn--xs"
                          onClick={() =>
                            onRemove(
                              g.id,
                              `${name}（${g.employee_number}）L${g.level} ${AI_LEVEL_KIND_LABEL[g.kind]} ${g.certified_at}`,
                            )
                          }
                          disabled={saving}
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

export default AiLevelAdminPage;
