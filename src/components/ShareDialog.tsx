import { useEffect, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { buildShareUrl } from "../lib/share";
import { useVersionsStore } from "../store/useVersionsStore";
import { useAuthStore } from "../store/useAuthStore";
import { getAuthor } from "../lib/author";

/**
 * One-step share dialog. Opens, auto-saves the current state to the server
 * (overwriting the loaded file when possible, otherwise creating a new
 * "共有用 ..." snapshot), and immediately shows the shareable URL. The user
 * never has to choose between "save" and "share" — the action they wanted
 * was always "give me a link to what I'm looking at right now".
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const dirty = useOrgStore((s) => s.dirty);
  const nodes = useOrgStore((s) => s.nodes);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const currentVersionLabel = useOrgStore((s) => s.currentVersionLabel);
  const markClean = useOrgStore((s) => s.markClean);
  const setToast = useOrgStore((s) => s.setToast);
  const save = useVersionsStore((s) => s.save);
  const updateSnapshot = useVersionsStore((s) => s.updateSnapshot);
  const view = useUiStore((s) => s.view);
  const currentUser = useAuthStore((s) => s.currentUser);

  const [versionIdToShare, setVersionIdToShare] = useState<string | null>(currentVersionId);
  const [versionLabelToShare, setVersionLabelToShare] = useState<string | null>(currentVersionLabel);
  const [phase, setPhase] = useState<"preparing" | "ready" | "error">("preparing");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guard against React StrictMode double-invocation in dev — without this
  // we'd save twice on mount.
  const initRan = useRef(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (initRan.current) return;
    initRan.current = true;
    void prepareShare();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Resolve "the URL the user wants" through three branches:
   *   1. Confirmed file or read-only: share the loaded version as-is.
   *   2. Editable file with no unsaved changes: share the loaded version.
   *   3. Anything else: persist the current state (overwrite if we own the
   *      file; create a fresh "共有用..." snapshot otherwise) then share it.
   */
  async function prepareShare() {
    const author = getAuthor() ?? currentUser?.display_name ?? "共有";

    const canOverwrite =
      !!currentVersionId && currentUser?.role !== "viewer";

    // Branch 1+2: nothing to write. Just share the loaded version.
    if (currentVersionId && (!dirty || currentUser?.role === "viewer")) {
      setVersionIdToShare(currentVersionId);
      setVersionLabelToShare(currentVersionLabel);
      setPhase("ready");
      return;
    }

    // Branch 3a: overwrite the loaded file with the latest state.
    if (canOverwrite && dirty) {
      const row = await updateSnapshot(currentVersionId, nodes);
      if (!row) {
        return finishWithError(
          "現在のファイルへの上書き保存に失敗しました。手動で保存してから再度お試しください。",
        );
      }
      markClean({ versionId: row.id, versionLabel: row.name });
      setVersionIdToShare(row.id);
      setVersionLabelToShare(row.name);
      setPhase("ready");
      return;
    }

    // Branch 3b: nothing loaded — auto-create a new file.
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const autoName =
      `共有用 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const row = await save({
      name: autoName,
      author,
      note: "共有リンク発行のため自動保存",
      nodes,
      created_by_email: currentUser?.email ?? null,
    });
    if (!row) {
      return finishWithError("共有用ファイルの作成に失敗しました。");
    }
    markClean({ versionId: row.id, versionLabel: row.name });
    setVersionIdToShare(row.id);
    setVersionLabelToShare(row.name);
    setPhase("ready");
  }

  function finishWithError(msg: string) {
    setErrorMessage(msg);
    setPhase("error");
  }

  const url = versionIdToShare ? buildShareUrl(versionIdToShare, view) : "";

  function handleCopy() {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(
      () => setToast({ kind: "info", message: "URLをコピーしました" }),
      () => inputRef.current?.select(),
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">共有リンクを発行</h3>
        <p className="modal__body" style={{ margin: "0 0 12px" }}>
          共有先のメンバーは、リンクを開くだけで組織図を閲覧できます（編集不可）。
          リンク先ではツリー／リストの両ビューを切り替えて閲覧可能です。
        </p>

        {phase === "preparing" && (
          <div className="share-prep">
            <p className="modal__body">準備中…（最新の状態を保存しています）</p>
          </div>
        )}

        {phase === "error" && (
          <>
            <p className="versions__error" style={{ marginBottom: 12 }}>{errorMessage}</p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onClose}>閉じる</button>
              <button
                className="btn btn--primary"
                onClick={() => {
                  setPhase("preparing");
                  setErrorMessage(null);
                  void prepareShare();
                }}
              >
                再試行
              </button>
            </div>
          </>
        )}

        {phase === "ready" && (
          <>
            <div className="share-version">
              共有するバージョン：<strong>{versionLabelToShare ?? "（無題）"}</strong>
            </div>
            <label className="field" style={{ marginTop: 12 }}>
              <span className="field__label">共有URL</span>
              <input
                ref={inputRef}
                className="field__input"
                value={url}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
            <div className="share-tips">
              リンク先のデフォルト表示：
              <strong>
                {view === "list"
                  ? "組織図リスト"
                  : view === "assignments"
                    ? "配属一覧"
                    : "組織図ツリー"}
              </strong>
              （現在のタブをそのまま反映）
            </div>
            <div className="modal__actions" style={{ marginTop: 12 }}>
              <button className="btn btn--ghost" onClick={onClose}>閉じる</button>
              <button className="btn btn--primary" onClick={handleCopy}>
                URLをコピー
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
