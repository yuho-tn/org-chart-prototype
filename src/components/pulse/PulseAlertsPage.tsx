import { useEffect, useState } from "react";
import "./pulse-shared.css";
import "./alerts.css";
import { usePulseAlertsStore, type ActionInput, type AssigneeOption } from "../../store/usePulseAlertsStore";
import { PulseSubnav } from "./PulseSubnav";
import { usePulseToast, PulseToast, type PulseToastKind } from "./usePulseToast";
import {
  periodLabel,
  ALERT_TYPE_LABEL,
  ACTION_STATE_LABEL,
  alertReasonSummary,
  type PulseAlertRow,
  type PulseActionState,
} from "../../lib/pulse";
import { buildCsv, downloadCsv } from "../../lib/pulseCsv";

/**
 * パルスサーベイ アラート一覧＋対応管理（#/pulse/alerts）。
 * can_manage_alert 保有者向け。対象者氏名は実名閲覧権でマスク。
 * 各アラートに1件の対応レコード（担当/状態/期日/メモ）を紐付けて管理する。
 */
export function PulseAlertsPage() {
  const {
    loaded,
    loading,
    error,
    evaluating,
    cycles,
    selectedPeriod,
    assignees,
    alerts,
    load,
    selectPeriod,
    reevaluate,
  } = usePulseAlertsStore();
  const { toast, showToast, clearToast } = usePulseToast();

  useEffect(() => {
    load();
  }, [load]);

  const onReevaluate = async () => {
    const res = await reevaluate();
    showToast(
      res.ok ? "success" : "error",
      res.ok ? "アラートを再判定しました" : res.reason ?? "再判定に失敗しました",
    );
  };

  const openCount = alerts.filter((a) => a.status === "open").length;

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ アラート</h1>
          <p className="pdash__sub">低スコア・急降下を検知し、対応状況を管理します（実名は閲覧権でマスク）</p>
        </div>
        <div className="pdash__controls">
          <select
            className="pdash__select"
            value={selectedPeriod ?? ""}
            onChange={(e) => selectPeriod(e.target.value)}
          >
            {cycles.map((c) => (
              <option key={c.id} value={c.period}>
                {periodLabel(c.period)}（{c.status === "sent" ? "受付中" : c.status === "closed" ? "終了" : "予定"}）
              </option>
            ))}
          </select>
          <button className="pdash__btn" onClick={onReevaluate} disabled={evaluating || !selectedPeriod}>
            {evaluating ? "判定中…" : "アラート再判定"}
          </button>
          <button
            className="pdash__btn"
            disabled={alerts.length === 0}
            onClick={() => {
              // 表示中と同じマスク通過データのみ（実名非公開は空欄のまま出力）
              const csv = buildCsv(
                ["氏名", "部署", "種別", "内容", "状態", "検知日時", "対応状態", "対応担当", "対応期日", "対応メモ"],
                alerts.map((a) => [
                  a.subject_name ?? "",
                  a.subject_department ?? "",
                  ALERT_TYPE_LABEL[a.type],
                  alertReasonSummary(a.type, a.reason),
                  a.status === "open" ? "オープン" : "クローズ",
                  a.created_at,
                  a.action ? ACTION_STATE_LABEL[a.action.state] : "",
                  a.action?.assignee_name ?? "",
                  a.action?.due_date ?? "",
                  a.action?.note ?? "",
                ]),
              );
              downloadCsv(`pulse_alerts_${selectedPeriod ?? "all"}.csv`, csv);
            }}
          >
            CSVダウンロード
          </button>
        </div>
      </header>

      <PulseSubnav active="alerts" />

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && cycles.length === 0 && (
        <p className="pdash__muted">サーベイのサイクルがまだありません。</p>
      )}

      {loaded && !error && cycles.length > 0 && (
        <>
          <p className="palert__summary">
            {alerts.length === 0
              ? "この期間のアラートはありません。"
              : `未対応 ${openCount} 件 / 全 ${alerts.length} 件`}
          </p>
          <div className="palert__list">
            {alerts.map((a) => (
              // key に status / action.updated_at を含め、reevaluate や他画面からの
              // 更新でサーバ側データが変わった時にローカルformを確実に再同期する
              // （旧実装は alert_id 固定keyのため、対応済みデータが古いフォーム値のまま
              // 表示され続けるズレが起きていた）。
              <AlertCard
                key={`${a.alert_id}:${a.status}:${a.action?.updated_at ?? "none"}`}
                alert={a}
                assignees={assignees}
                onToast={showToast}
              />
            ))}
          </div>
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
    </main>
  );
}

function AlertCard({
  alert,
  assignees,
  onToast,
}: {
  alert: PulseAlertRow;
  assignees: AssigneeOption[];
  onToast: (kind: PulseToastKind, m: string) => void;
}) {
  const setStatus = usePulseAlertsStore((s) => s.setStatus);
  const saveAction = usePulseAlertsStore((s) => s.saveAction);
  const busyId = usePulseAlertsStore((s) => s.busyId);
  const busy = busyId === alert.alert_id;

  const [form, setForm] = useState<ActionInput>({
    assignee_employee_number: alert.action?.assignee_employee_number ?? null,
    state: alert.action?.state ?? "todo",
    due_date: alert.action?.due_date ?? null,
    note: alert.action?.note ?? null,
  });

  const closed = alert.status === "closed";

  const onSave = async () => {
    const res = await saveAction(alert.alert_id, form);
    onToast(res.ok ? "success" : "error", res.ok ? "対応内容を保存しました" : res.reason ?? "保存に失敗しました");
  };

  const onToggleStatus = async () => {
    const res = await setStatus(alert.alert_id, closed ? "open" : "closed");
    onToast(
      res.ok ? "success" : "error",
      res.ok ? (closed ? "再オープンしました" : "クローズしました") : res.reason ?? "更新に失敗しました",
    );
  };

  return (
    <section className={"palert__card" + (closed ? " is-closed" : "")}>
      <div className="palert__top">
        <div className="palert__who">
          <span className="palert__name">{alert.subject_name ?? "（実名非公開）"}</span>
          {alert.subject_department && <span className="palert__dept">{alert.subject_department}</span>}
        </div>
        <div className="palert__badges">
          <span className={`palert__type palert__type--${alert.type}`}>{ALERT_TYPE_LABEL[alert.type]}</span>
          <span className={`palert__status palert__status--${alert.status}`}>
            {closed ? "クローズ" : "未対応"}
          </span>
        </div>
      </div>

      <p className="palert__reason">{alertReasonSummary(alert.type, alert.reason)}</p>

      <div className="palert__action">
        <div className="palert__field">
          <label>対応状況</label>
          <select
            value={form.state}
            onChange={(e) => setForm((f) => ({ ...f, state: e.target.value as PulseActionState }))}
          >
            {(["todo", "doing", "done"] as PulseActionState[]).map((s) => (
              <option key={s} value={s}>
                {ACTION_STATE_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div className="palert__field">
          <label>担当</label>
          <select
            value={form.assignee_employee_number ?? ""}
            onChange={(e) =>
              setForm((f) => ({ ...f, assignee_employee_number: e.target.value || null }))
            }
          >
            <option value="">未割当</option>
            {assignees.map((a) => (
              <option key={a.employee_number} value={a.employee_number}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div className="palert__field">
          <label>期日</label>
          <input
            type="date"
            value={form.due_date ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, due_date: e.target.value || null }))}
          />
        </div>
        <div className="palert__field palert__field--wide">
          <label>メモ</label>
          <textarea
            rows={2}
            value={form.note ?? ""}
            placeholder="対応の記録・次アクションなど"
            onChange={(e) => setForm((f) => ({ ...f, note: e.target.value || null }))}
          />
        </div>
      </div>

      <div className="palert__buttons">
        <button className="pdash__btn pdash__btn--primary" onClick={onSave} disabled={busy}>
          {busy ? "保存中…" : "対応を保存"}
        </button>
        <button className="pdash__btn" onClick={onToggleStatus} disabled={busy}>
          {closed ? "再オープン" : "クローズ"}
        </button>
        {alert.action?.updated_at && (
          <span className="palert__updated">
            最終更新 {new Date(alert.action.updated_at).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}
          </span>
        )}
      </div>
    </section>
  );
}

export default PulseAlertsPage;
