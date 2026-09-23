import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import "./pulse-shared.css";
import "./alerts.css";
import {
  usePulseAlertsStore,
  type AssigneeOption,
  type AlertActionPatch,
} from "../../store/usePulseAlertsStore";
import { useUiStore } from "../../store/useUiStore";
import { PulseSubnav } from "./PulseSubnav";
import { usePulseToast, PulseToast, type PulseToastKind } from "./usePulseToast";
import {
  periodLabel,
  periodShort,
  CYCLE_STATUS_LABEL,
  ACTION_STATE_LABEL,
  ACTION_STATE_ORDER,
  ALERT_SEVERITY_LABEL,
  ALERT_SOURCE_LABEL,
  alertReasonSummary,
  alertRuleLabel,
  type PulseAlertRow,
  type PulseActionState,
  type PulseAlertSeverity,
  type PulseAlertReviewRow,
} from "../../lib/pulse";
import { buildCsv, downloadCsv } from "../../lib/pulseCsv";

type StateFilter = PulseActionState | "all";
type SeverityFilter = PulseAlertSeverity | "all";

/** action が無いアラート（対応レコード未作成）は「未対応」扱い。 */
function actionStateOf(a: PulseAlertRow): PulseActionState {
  return a.action?.state ?? "todo";
}

/**
 * パルスサーベイ アラート一覧＋対応管理＋振り返り（#/pulse/alerts・設計書 §10-8）。
 * can_manage_alert 保有者向け。対象者氏名・コメント要約は実名閲覧権でマスク。
 * 「アラート」タブ：状態/ルール/担当/重要度で絞り込み、チェックボックスで複数選択して
 * 一括更新（pulse_bulk_update_alert_actions）。行内でも対応名/状態/担当/期日/メモを編集可。
 * 「振り返り」タブ：当月アラート発生者の基準期→直近の推移（pulse_alert_review）。
 */
export function PulseAlertsPage() {
  const {
    loaded,
    loading,
    error,
    evaluating,
    bulkUpdating,
    cycles,
    selectedPeriod,
    periodMode,
    assignees,
    alerts,
    tab,
    load,
    selectPeriod,
    selectAllPeriods,
    setTab,
    reevaluate,
    bulkUpdate,
  } = usePulseAlertsStore();
  const navigate = useUiStore((s) => s.navigate);
  const { toast, showToast, clearToast } = usePulseToast();

  useEffect(() => {
    load();
  }, [load]);

  // ── フィルタ（表示専用・ローカル state） ──────────────────────────
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [ruleFilter, setRuleFilter] = useState<string>("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all"); // "all" | "unassigned" | employee_number
  const [severityFilter, setSeverityFilter] = useState<SeverityFilter>("all");

  // 期間切替やタブ切替のたびにフィルタを引き継がずリセットする。useEffect ではなく
  // 「レンダー中に前回のscopeKeyと比較して直接setStateする」React推奨パターンで行う
  // （setState-in-effect を避け、切替の瞬間に古い期間のフィルタ条件が一瞬でも
  // 表示に使われることも防ぐ）。
  const scopeKey = periodMode === "all" ? "__all__" : (selectedPeriod ?? "");
  const [filterScopeKey, setFilterScopeKey] = useState(scopeKey);
  if (filterScopeKey !== scopeKey) {
    setFilterScopeKey(scopeKey);
    setStateFilter("all");
    setRuleFilter("all");
    setAssigneeFilter("all");
    setSeverityFilter("all");
  }

  const ruleOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of alerts) {
      const code = a.rule_code || a.type;
      if (code) map.set(code, a.rule_label || alertRuleLabel(code));
    }
    return Array.from(map.entries()).sort((x, y) => x[1].localeCompare(y[1], "ja"));
  }, [alerts]);

  const filtered = useMemo(() => {
    return alerts.filter((a) => {
      if (stateFilter !== "all" && actionStateOf(a) !== stateFilter) return false;
      if (ruleFilter !== "all" && (a.rule_code || a.type) !== ruleFilter) return false;
      if (severityFilter !== "all" && a.severity !== severityFilter) return false;
      if (assigneeFilter === "unassigned" && a.action?.assignee_employee_number) return false;
      if (
        assigneeFilter !== "all" &&
        assigneeFilter !== "unassigned" &&
        a.action?.assignee_employee_number !== assigneeFilter
      )
        return false;
      return true;
    });
  }, [alerts, stateFilter, ruleFilter, severityFilter, assigneeFilter]);

  // ── 選択（一括更新用チェックボックス） ────────────────────────────
  // alerts 入れ替え（期間切替・再判定・更新後）でもう存在しないIDは、選択state自体を
  // effectで刈り込まず、表示・操作に使う派生値（validSelected）側で毎レンダー除外する
  // （setState-in-effect を避ける。生の selected は toggle のトグル対象としてのみ使う）。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const validSelected = useMemo(() => {
    if (selected.size === 0) return selected;
    const ids = new Set(alerts.map((a) => a.alert_id));
    let changed = false;
    const next = new Set<string>();
    selected.forEach((id) => {
      if (ids.has(id)) next.add(id);
      else changed = true;
    });
    return changed ? next : selected;
  }, [selected, alerts]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => validSelected.has(a.alert_id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((a) => next.delete(a.alert_id));
      } else {
        filtered.forEach((a) => next.add(a.alert_id));
      }
      return next;
    });
  };

  // ── 一括更新バー ────────────────────────────────────────────────
  const [bulkState, setBulkState] = useState<"__keep__" | PulseActionState>("__keep__");
  const [bulkAssignee, setBulkAssignee] = useState<string>("__keep__"); // "__keep__" | "" | employee_number
  const [bulkDue, setBulkDue] = useState("");
  const [bulkDueClear, setBulkDueClear] = useState(false);
  const [bulkTitle, setBulkTitle] = useState("");
  const [bulkTitleClear, setBulkTitleClear] = useState(false);

  const hasBulkPatch =
    bulkState !== "__keep__" ||
    bulkAssignee !== "__keep__" ||
    bulkDueClear ||
    bulkDue !== "" ||
    bulkTitleClear ||
    bulkTitle.trim() !== "";

  const resetBulkForm = () => {
    setBulkState("__keep__");
    setBulkAssignee("__keep__");
    setBulkDue("");
    setBulkDueClear(false);
    setBulkTitle("");
    setBulkTitleClear(false);
  };

  const onBulkApply = async () => {
    const patch: AlertActionPatch = {};
    if (bulkState !== "__keep__") patch.state = bulkState;
    if (bulkAssignee !== "__keep__") patch.assignee_employee_number = bulkAssignee || null;
    if (bulkDueClear) patch.due_date = null;
    else if (bulkDue) patch.due_date = bulkDue;
    if (bulkTitleClear) patch.title = null;
    else if (bulkTitle.trim()) patch.title = bulkTitle.trim();

    const res = await bulkUpdate(Array.from(validSelected), patch);
    showToast(res.ok ? "success" : "error", res.reason ?? (res.ok ? "更新しました" : "更新に失敗しました"));
    if (res.ok) {
      setSelected(new Set());
      resetBulkForm();
    }
  };

  // ── ヘッダー操作 ────────────────────────────────────────────────
  const onReevaluate = async () => {
    const res = await reevaluate();
    showToast(
      res.ok ? "success" : "error",
      res.ok ? "アラートを再判定しました" : res.reason ?? "再判定に失敗しました",
    );
  };

  const onCsv = () => {
    // 表示中（フィルタ後）と同じマスク通過データのみ（実名非公開は空欄のまま出力）
    const csv = buildCsv(
      [
        "期間",
        "氏名",
        "部署",
        "ルール",
        "理由",
        "重要度",
        "分類",
        "コメント要約",
        "上長開示",
        "状態",
        "対応名",
        "対応期日",
        "対応担当",
        "検知日時",
        "メモ",
      ],
      filtered.map((a) => [
        a.period,
        a.subject_name ?? "",
        a.subject_department ?? "",
        a.rule_label || alertRuleLabel(a.rule_code || a.type),
        alertReasonSummary(a.rule_code || a.type, a.reason),
        ALERT_SEVERITY_LABEL[a.severity] ?? a.severity,
        (a.categories ?? []).join("・"),
        a.comment_summary ?? "",
        a.disclose_to_manager ? "上長開示可" : "人事のみ",
        ACTION_STATE_LABEL[actionStateOf(a)],
        a.action?.title ?? "",
        a.action?.due_date ?? "",
        a.action?.assignee_name ?? "",
        a.created_at,
        a.action?.note ?? "",
      ]),
    );
    downloadCsv(`pulse_alerts_${periodMode === "all" ? "all" : (selectedPeriod ?? "none")}.csv`, csv);
  };

  const openCount = filtered.filter((a) => a.status === "open").length;
  const reviewPeriod = selectedPeriod ?? cycles[0]?.period ?? null;

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ アラート</h1>
          <p className="pdash__sub">
            Geppo互換ルール・プリセット・コメント分類から検知したアラートを管理します（実名は閲覧権でマスク）
          </p>
        </div>
        <div className="pdash__controls">
          <select
            className="pdash__select"
            value={periodMode === "all" ? "__all__" : (selectedPeriod ?? "")}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "__all__") selectAllPeriods();
              else selectPeriod(v);
            }}
          >
            <option value="__all__">すべて（直近12か月）</option>
            {cycles.map((c) => (
              <option key={c.id} value={c.period}>
                {periodLabel(c.period)}（{CYCLE_STATUS_LABEL[c.status] ?? c.status}）
              </option>
            ))}
          </select>
          {tab === "alerts" && (
            <>
              <button
                className="pdash__btn"
                onClick={onReevaluate}
                disabled={evaluating || periodMode === "all" || !selectedPeriod}
                title={periodMode === "all" ? "「すべて」表示では再判定できません。対象月を選んでください" : undefined}
              >
                {evaluating ? "判定中…" : "アラート再判定"}
              </button>
              <button className="pdash__btn" disabled={filtered.length === 0} onClick={onCsv}>
                CSVダウンロード
              </button>
            </>
          )}
        </div>
      </header>

      <PulseSubnav active="alerts" />

      <nav className="palr__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "alerts"}
          className={"palr__tab" + (tab === "alerts" ? " is-active" : "")}
          onClick={() => setTab("alerts")}
        >
          アラート
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "review"}
          className={"palr__tab" + (tab === "review" ? " is-active" : "")}
          onClick={() => setTab("review")}
        >
          振り返り
        </button>
      </nav>

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && cycles.length === 0 && (
        <p className="pdash__muted">サーベイのサイクルがまだありません。</p>
      )}

      {loaded && !error && cycles.length > 0 && tab === "alerts" && (
        <>
          <div className="palr__toolbar">
            <label className="palr__filter">
              <span>状態</span>
              <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)}>
                <option value="all">すべて</option>
                {ACTION_STATE_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {ACTION_STATE_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <label className="palr__filter">
              <span>ルール</span>
              <select value={ruleFilter} onChange={(e) => setRuleFilter(e.target.value)}>
                <option value="all">すべて</option>
                {ruleOptions.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="palr__filter">
              <span>担当</span>
              <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
                <option value="all">すべて</option>
                <option value="unassigned">未割当</option>
                {assignees.map((a) => (
                  <option key={a.employee_number} value={a.employee_number}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="palr__filter">
              <span>重要度</span>
              <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as SeverityFilter)}>
                <option value="all">すべて</option>
                {(["critical", "warn", "info"] as PulseAlertSeverity[]).map((s) => (
                  <option key={s} value={s}>
                    {ALERT_SEVERITY_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="palr__summary">
            {alerts.length === 0
              ? "この期間のアラートはありません。"
              : filtered.length === alerts.length
                ? `未完了 ${openCount} 件 / 全 ${alerts.length} 件`
                : `未完了 ${openCount} 件 / 表示 ${filtered.length} 件（全 ${alerts.length} 件）`}
          </p>

          {validSelected.size > 0 && (
            <div className="palr__bulkbar">
              <span className="palr__bulkcount">{validSelected.size}件を選択中</span>
              <label className="palr__bulkfield">
                <span>状態</span>
                <select value={bulkState} onChange={(e) => setBulkState(e.target.value as "__keep__" | PulseActionState)}>
                  <option value="__keep__">変更しない</option>
                  {ACTION_STATE_ORDER.map((s) => (
                    <option key={s} value={s}>
                      {ACTION_STATE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="palr__bulkfield">
                <span>担当</span>
                <select value={bulkAssignee} onChange={(e) => setBulkAssignee(e.target.value)}>
                  <option value="__keep__">変更しない</option>
                  <option value="">未割当にする</option>
                  {assignees.map((a) => (
                    <option key={a.employee_number} value={a.employee_number}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="palr__bulkfield">
                <span>期日</span>
                <input
                  type="date"
                  value={bulkDue}
                  disabled={bulkDueClear}
                  onChange={(e) => setBulkDue(e.target.value)}
                />
                <span className="palr__bulkclear">
                  <input
                    type="checkbox"
                    checked={bulkDueClear}
                    onChange={(e) => {
                      setBulkDueClear(e.target.checked);
                      if (e.target.checked) setBulkDue("");
                    }}
                  />
                  クリア
                </span>
              </label>
              <label className="palr__bulkfield">
                <span>対応名</span>
                <input
                  type="text"
                  placeholder="例：産業医面談"
                  value={bulkTitle}
                  disabled={bulkTitleClear}
                  onChange={(e) => setBulkTitle(e.target.value)}
                />
                <span className="palr__bulkclear">
                  <input
                    type="checkbox"
                    checked={bulkTitleClear}
                    onChange={(e) => {
                      setBulkTitleClear(e.target.checked);
                      if (e.target.checked) setBulkTitle("");
                    }}
                  />
                  クリア
                </span>
              </label>
              <button
                className="pdash__btn pdash__btn--primary"
                onClick={onBulkApply}
                disabled={!hasBulkPatch || bulkUpdating}
              >
                {bulkUpdating ? "更新中…" : `一括更新（${validSelected.size}件）`}
              </button>
              <button className="pdash__btn" onClick={() => setSelected(new Set())} disabled={bulkUpdating}>
                選択解除
              </button>
            </div>
          )}

          <div className="palr__tablewrap">
            <table className="palr__table">
              <thead>
                <tr>
                  <th className="palr__checkcell">
                    <input
                      type="checkbox"
                      className="palr__headcheck"
                      checked={allFilteredSelected}
                      onChange={toggleAll}
                      disabled={filtered.length === 0}
                      aria-label="すべて選択"
                    />
                  </th>
                  <th>対象者</th>
                  <th>期間</th>
                  <th>ルール</th>
                  <th>理由</th>
                  <th>コメント</th>
                  <th>重要度</th>
                  <th>開示</th>
                  <th>対応</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={10} className="pdash__muted" style={{ padding: 16 }}>
                      該当するアラートはありません。
                    </td>
                  </tr>
                )}
                {filtered.map((a) => (
                  <AlertRow
                    // status / action.updated_at をkeyに含め、一括更新・再判定など他経路の
                    // 更新後にローカルformが古い値のまま表示され続けるズレを防ぐ（PulseAlertCard由来の作法）。
                    key={`${a.alert_id}:${a.status}:${a.action?.updated_at ?? "none"}`}
                    alert={a}
                    assignees={assignees}
                    checked={validSelected.has(a.alert_id)}
                    onToggle={toggle}
                    onToast={showToast}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {loaded && !error && cycles.length > 0 && tab === "review" && (
        <>
          <p className="pdash__muted" style={{ marginBottom: 10 }}>
            {reviewPeriod
              ? `対象月：${periodLabel(reviewPeriod)}（アラートが発生した人の基準期→直近の推移。上長開示可否に関わらず人事は全件閲覧可）`
              : "対象月がありません。"}
          </p>
          <ReviewTable period={reviewPeriod} onOpenMember={(num) => navigate({ name: "pulse_member", num })} />
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
    </main>
  );
}

// ── アラート行（インライン編集） ────────────────────────────────────

function AlertRow({
  alert,
  assignees,
  checked,
  onToggle,
  onToast,
}: {
  alert: PulseAlertRow;
  assignees: AssigneeOption[];
  checked: boolean;
  onToggle: (id: string) => void;
  onToast: (kind: PulseToastKind, m: string) => void;
}) {
  const bulkUpdate = usePulseAlertsStore((s) => s.bulkUpdate);
  const deleteAction = usePulseAlertsStore((s) => s.deleteAction);
  const busyId = usePulseAlertsStore((s) => s.busyId);
  const busy = busyId === alert.alert_id;

  const [form, setForm] = useState({
    title: alert.action?.title ?? "",
    state: (alert.action?.state ?? "todo") as PulseActionState,
    assignee_employee_number: alert.action?.assignee_employee_number ?? "",
    due_date: alert.action?.due_date ?? "",
    note: alert.action?.note ?? "",
  });

  const closed = alert.status === "closed";
  const ruleCode = alert.rule_code || alert.type;
  const reasonText = alertReasonSummary(ruleCode, alert.reason);

  const onSave = async () => {
    const res = await bulkUpdate([alert.alert_id], {
      title: form.title.trim() || null,
      state: form.state,
      assignee_employee_number: form.assignee_employee_number || null,
      due_date: form.due_date || null,
      note: form.note.trim() || null,
    });
    onToast(res.ok ? "success" : "error", res.ok ? "対応を保存しました" : res.reason ?? "保存に失敗しました");
  };

  const onDelete = async () => {
    if (!window.confirm("この対応記録を削除しますか？（アラート自体は残り、未対応に戻ります）")) return;
    const res = await deleteAction(alert.alert_id);
    onToast(res.ok ? "success" : "error", res.ok ? "対応記録を削除しました" : res.reason ?? "削除に失敗しました");
  };

  return (
    <tr className={"palr__row" + (closed ? " is-closed" : "") + (checked ? " is-selected" : "")}>
      <td className="palr__checkcell">
        <input type="checkbox" checked={checked} onChange={() => onToggle(alert.alert_id)} aria-label="選択" />
      </td>
      <td>
        <div className="palr__who">
          <span className="palr__name">{alert.subject_name ?? "（実名非公開）"}</span>
          {alert.subject_department && <span className="palr__dept">{alert.subject_department}</span>}
        </div>
      </td>
      <td>
        <span className="palr__period" title={periodLabel(alert.period)}>
          {periodShort(alert.period)}
        </span>
        {alert.sum_score != null && (
          <div className="palr__score">
            {alert.sum_score}/20{alert.prev_sum_score != null && `（前回${alert.prev_sum_score}）`}
          </div>
        )}
      </td>
      <td>
        <div className="palr__rule">
          <span className="palr__rulelabel">{alert.rule_label || alertRuleLabel(ruleCode)}</span>
          <span className="palr__source">{ALERT_SOURCE_LABEL[alert.source] ?? alert.source}</span>
        </div>
      </td>
      <td>
        <p className="palr__reason" title={reasonText}>
          {reasonText}
        </p>
      </td>
      <td>
        {alert.comment_summary ? (
          <span className="palr__chip" title={alert.comment_summary}>
            {alert.comment_summary}
          </span>
        ) : alert.comment_categories && alert.comment_categories.length > 0 ? (
          <span className="palr__chip" title={alert.comment_categories.join("・")}>
            {alert.comment_categories.join("・")}
          </span>
        ) : (
          <span className="palr__nodata">—</span>
        )}
      </td>
      <td>
        <span className={`palr__badge palr__badge--${alert.severity}`}>
          {ALERT_SEVERITY_LABEL[alert.severity] ?? alert.severity}
        </span>
      </td>
      <td>
        {alert.disclose_to_manager ? (
          <span className="palr__badge palr__badge--manager">上長開示可</span>
        ) : (
          <span className="palr__badge palr__badge--muted">人事のみ</span>
        )}
      </td>
      <td className="palr__actioncell">
        <div className="palr__actiongrid">
          <input
            placeholder="対応名"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <select
            value={form.state}
            onChange={(e) => setForm((f) => ({ ...f, state: e.target.value as PulseActionState }))}
          >
            {ACTION_STATE_ORDER.map((s) => (
              <option key={s} value={s}>
                {ACTION_STATE_LABEL[s]}
              </option>
            ))}
          </select>
          <select
            value={form.assignee_employee_number}
            onChange={(e) => setForm((f) => ({ ...f, assignee_employee_number: e.target.value }))}
          >
            <option value="">未割当</option>
            {assignees.map((a) => (
              <option key={a.employee_number} value={a.employee_number}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={form.due_date}
            onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value }))}
          />
          <textarea
            rows={1}
            placeholder="メモ"
            value={form.note}
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
          />
        </div>
      </td>
      <td>
        <div className="palr__rowbtns">
          <button className="pdash__btn pdash__btn--primary" onClick={onSave} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
          <button className="pdash__btn palr__delbtn" onClick={onDelete} disabled={busy}>
            <Trash2 size={12} aria-hidden /> 削除
          </button>
          {alert.action?.updated_at && (
            <span className="palr__updated">
              {new Date(alert.action.updated_at).toLocaleDateString("ja-JP", { dateStyle: "short" })} 更新
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── 振り返りタブ ────────────────────────────────────────────────

function ReviewTable({ period, onOpenMember }: { period: string | null; onOpenMember: (num: string) => void }) {
  const { review, reviewError, reviewPeriod, loadReview } = usePulseAlertsStore();

  useEffect(() => {
    if (period && reviewPeriod !== period) loadReview(period);
  }, [period, reviewPeriod, loadReview]);

  if (!period) return <p className="pdash__muted">対象月がありません。</p>;
  if (reviewError) return <p className="pdash__error">{reviewError}</p>;
  // reviewPeriod（最後に読込完了した期間）が target の period とまだ一致しない間は
  // 必ず読込中（初回・切替直後はもちろん、reviewLoading が立つ間は常にこの不一致状態）。
  if (reviewPeriod !== period) return <p className="pdash__muted">読み込み中…</p>;
  if (review.length === 0) {
    return <p className="pdash__muted">{periodLabel(period)}にアラートが発生した人はいません。</p>;
  }

  return (
    <div className="palr__revtablewrap">
      <table className="palr__revtable">
        <thead>
          <tr>
            <th>対象者</th>
            <th>部署</th>
            <th>該当ルール</th>
            <th>基準期</th>
            <th>直近</th>
            <th>差分</th>
            <th>推移</th>
            <th>対応</th>
          </tr>
        </thead>
        <tbody>
          {review.map((r) => (
            <ReviewRow key={r.employee_number} r={r} onClick={() => onOpenMember(r.employee_number)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReviewRow({ r, onClick }: { r: PulseAlertReviewRow; onClick: () => void }) {
  const deltaDir = r.delta == null ? "flat" : r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat";
  return (
    <tr className="palr__revrow" onClick={onClick}>
      <td>{r.name ?? "（実名非公開）"}</td>
      <td>{r.department ?? "—"}</td>
      <td>
        <div className="palr__revtypes">
          {r.alert_types.map((t) => (
            <span key={t} className="palr__chip">
              {alertRuleLabel(t)}
            </span>
          ))}
        </div>
      </td>
      <td>
        {periodShort(r.base_period)}：{r.base_sum ?? "—"}
      </td>
      <td>{r.latest_period ? `${periodShort(r.latest_period)}：${r.latest_sum ?? "—"}` : "—"}</td>
      <td className={`palr__delta is-${deltaDir}`}>{r.delta == null ? "—" : `${r.delta > 0 ? "+" : ""}${r.delta}`}</td>
      <td>
        <ReviewSpark series={r.series} basePeriod={r.base_period} />
      </td>
      <td>
        {r.action_state ? ACTION_STATE_LABEL[r.action_state] : "未対応"}
        {r.action_title && ` ／ ${r.action_title}`}
      </td>
    </tr>
  );
}

/** 振り返り行の6点スパークライン（合計/20点）。基準期の点を強調表示する。 */
function ReviewSpark({
  series,
  basePeriod,
}: {
  series: { period: string; sum: number | null }[];
  basePeriod: string;
}) {
  const pts = series.filter((p) => p.sum != null) as { period: string; sum: number }[];
  if (pts.length < 2) return <span className="pdash__muted">—</span>;
  const W = 90;
  const H = 22;
  const pad = 3;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const ys = (v: number) => H - pad - (v / 20) * (H - pad * 2);
  const line = pts.map((p, i) => `${xs(i)},${ys(p.sum)}`).join(" ");
  return (
    <svg className="palr__revspark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={line} fill="none" className="palr__revspark-line" />
      {pts.map((p, i) => (
        <circle
          key={p.period}
          cx={xs(i)}
          cy={ys(p.sum)}
          r={p.period === basePeriod ? 2.6 : 1.7}
          className={p.period === basePeriod ? "palr__revspark-base" : "palr__revspark-dot"}
        />
      ))}
    </svg>
  );
}

export default PulseAlertsPage;
