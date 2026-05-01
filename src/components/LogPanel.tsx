import { useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import type { LogEntry } from "../lib/types";

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString("ja-JP", {
    month: "long",
    day: "numeric",
    weekday: "short",
  });
}

/**
 * Spreadsheet-style revision history. Hidden behind a TopBar button; opens
 * as a right-side drawer. Each entry exposes a 復元 button that rewinds the
 * tree to the state captured *before* that operation. The restore itself
 * lands in the log too so the user can step further back if they want.
 */
export function LogPanel() {
  const log = useOrgStore((s) => s.log);
  const restoreToLog = useOrgStore((s) => s.restoreToLog);
  const setToast = useOrgStore((s) => s.setToast);
  const showLog = useUiStore((s) => s.showLog);
  const setShowLog = useUiStore((s) => s.setShowLog);
  const [confirmEntry, setConfirmEntry] = useState<LogEntry | null>(null);

  if (!showLog) return null;

  function close() {
    setShowLog(false);
  }

  function tryRestore(entry: LogEntry) {
    if (!entry.snapshotBefore) {
      setToast({
        kind: "error",
        message: "このログには復元用の状態が記録されていません",
      });
      return;
    }
    setConfirmEntry(entry);
  }

  function confirmRestore() {
    if (!confirmEntry) return;
    const res = restoreToLog(confirmEntry.id);
    setConfirmEntry(null);
    if (!res.ok && res.reason) {
      setToast({ kind: "error", message: res.reason });
    } else {
      setShowLog(false);
    }
  }

  // Group entries by yyyy-mm-dd so the drawer reads like a journal.
  const groups: { label: string; entries: LogEntry[] }[] = [];
  for (const e of log) {
    const label = fmtDate(e.ts);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.entries.push(e);
    else groups.push({ label, entries: [e] });
  }

  return (
    <>
      <div className="logdrawer__backdrop" onClick={close} />
      <aside className="logdrawer" role="dialog" aria-label="操作履歴">
        <header className="logdrawer__head">
          <div>
            <h3 className="logdrawer__title">操作履歴</h3>
            <p className="logdrawer__hint">
              「復元」を押すとその操作の直前へ戻ります（最大{log.length}件）。
            </p>
          </div>
          <button className="btn btn--ghost btn--xs" onClick={close} aria-label="閉じる">
            ×
          </button>
        </header>
        <div className="logdrawer__list">
          {log.length === 0 && (
            <p className="logdrawer__empty">操作はまだありません</p>
          )}
          {groups.map((g) => (
            <section key={g.label} className="logdrawer__group">
              <h4 className="logdrawer__day">{g.label}</h4>
              <ul>
                {g.entries.map((e) => (
                  <li key={e.id} className={`logdrawer__row logdrawer__row--${e.action}`}>
                    <span className="logdrawer__time">{fmtTime(e.ts)}</span>
                    <span className="logdrawer__action">[{e.action}]</span>
                    <span className="logdrawer__detail">{e.detail}</span>
                    <button
                      className="btn btn--ghost btn--xs logdrawer__restore"
                      onClick={() => tryRestore(e)}
                      disabled={!e.snapshotBefore}
                      title={
                        e.snapshotBefore
                          ? "この操作の直前の状態へ復元"
                          : "復元用の状態が記録されていません"
                      }
                    >
                      ↶ 復元
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </aside>
      {confirmEntry && (
        <div className="modal-backdrop" onClick={() => setConfirmEntry(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">復元の確認</h3>
            <p className="modal__body">
              <strong>{confirmEntry.detail}</strong>
              <br />
              の直前の状態へ戻します。現在の状態は履歴に残るので、Undo か再度この履歴から元に戻せます。
            </p>
            <div className="modal__actions">
              <button
                className="btn btn--ghost"
                onClick={() => setConfirmEntry(null)}
              >
                キャンセル
              </button>
              <button className="btn btn--primary" onClick={confirmRestore}>
                復元する
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
