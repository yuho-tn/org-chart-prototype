import { useEffect, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { buildShareUrl } from "../lib/share";
import { useVersionsStore } from "../store/useVersionsStore";
import { getAuthor } from "../lib/author";

/**
 * Modal that lets the user generate and copy a public read-only URL pointing
 * at a saved version. If the current state is dirty (or no version is loaded),
 * we offer to save first.
 */
export function ShareDialog({ onClose }: { onClose: () => void }) {
  const dirty = useOrgStore((s) => s.dirty);
  const nodes = useOrgStore((s) => s.nodes);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const currentVersionLabel = useOrgStore((s) => s.currentVersionLabel);
  const markClean = useOrgStore((s) => s.markClean);
  const setToast = useOrgStore((s) => s.setToast);
  const save = useVersionsStore((s) => s.save);
  const view = useUiStore((s) => s.view);

  const [savingForShare, setSavingForShare] = useState(false);
  const [versionIdToShare, setVersionIdToShare] = useState<string | null>(
    currentVersionId,
  );
  const [versionLabelToShare, setVersionLabelToShare] = useState<string | null>(
    currentVersionLabel,
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSaveAndShare() {
    const author = getAuthor();
    if (!author) {
      setToast({
        kind: "error",
        message: "作成者の名前が未設定です。先に画面右上から設定してください",
      });
      return;
    }
    setSavingForShare(true);
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const autoName = `共有用 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const row = await save({
      name: autoName,
      author,
      note: "共有リンク発行のため自動保存",
      nodes,
    });
    setSavingForShare(false);
    if (!row) {
      setToast({ kind: "error", message: "保存に失敗したため共有URLを発行できませんでした" });
      return;
    }
    markClean({ versionId: row.id, versionLabel: row.name });
    setVersionIdToShare(row.id);
    setVersionLabelToShare(row.name);
  }

  const url = versionIdToShare ? buildShareUrl(versionIdToShare, view) : "";

  function handleCopy() {
    if (!url) return;
    navigator.clipboard?.writeText(url).then(
      () => setToast({ kind: "info", message: "URLをコピーしました" }),
      () => {
        // Fallback: select the input
        inputRef.current?.select();
      },
    );
  }

  const needsSave = !versionIdToShare || (dirty && versionIdToShare === currentVersionId);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">共有リンクを発行</h3>
        <p className="modal__body" style={{ margin: "0 0 12px" }}>
          共有先のメンバーは、リンクを開くだけで組織図を閲覧できます（編集不可）。
          リンク先ではツリー／リストの両ビューを切り替えて閲覧可能です。
        </p>

        {needsSave ? (
          <>
            <p className="share-notice">
              共有するには、現状をバージョンとして保存する必要があります。
              {dirty && currentVersionId && (
                <>
                  <br />
                  最新の保存済バージョン「<strong>{currentVersionLabel}</strong>」のURLを発行することもできます（編集中の差分は含まれません）。
                </>
              )}
            </p>
            <div className="modal__actions" style={{ marginTop: 12 }}>
              <button className="btn btn--ghost" onClick={onClose}>
                キャンセル
              </button>
              {dirty && currentVersionId && (
                <button
                  className="btn"
                  onClick={() => {
                    setVersionIdToShare(currentVersionId);
                    setVersionLabelToShare(currentVersionLabel);
                  }}
                >
                  最新の保存済バージョンで共有
                </button>
              )}
              <button
                className="btn btn--primary"
                onClick={handleSaveAndShare}
                disabled={savingForShare}
              >
                {savingForShare ? "保存中..." : "今の状態を保存して共有"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="share-version">
              共有するバージョン：<strong>{versionLabelToShare}</strong>
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
              リンク先のデフォルト表示：<strong>{view === "list" ? "リスト" : "ツリー"}</strong>
              （現在のタブをそのまま反映）
            </div>
            <div className="modal__actions" style={{ marginTop: 12 }}>
              <button className="btn btn--ghost" onClick={onClose}>
                閉じる
              </button>
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
