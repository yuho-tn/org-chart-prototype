import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useAuthStore } from "../store/useAuthStore";
import { SaveVersionDialog } from "./SaveVersionDialog";
import { ShareDialog } from "./ShareDialog";

function isFromTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * Editor sub-toolbar — shown directly under the global header when the user
 * is in the 組織図 → 編集 view. Owns the file-state badge and all editor-level
 * actions (undo/redo, copy/paste, history, share, save).
 *
 * The primary navigation lives in GlobalHeader; the section sub-tabs in
 * OrgSubNav. This component is intentionally limited to the active document.
 */
export function TopBar() {
  const dirty = useOrgStore((s) => s.dirty);
  const versionLabel = useOrgStore((s) => s.currentVersionLabel);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const nodes = useOrgStore((s) => s.nodes);
  const newFile = useOrgStore((s) => s.newFile);
  const markClean = useOrgStore((s) => s.markClean);
  const selectedId = useOrgStore((s) => s.selectedId);
  const clipboard = useOrgStore((s) => s.clipboard);
  const past = useOrgStore((s) => s.past);
  const future = useOrgStore((s) => s.future);
  const undo = useOrgStore((s) => s.undo);
  const redo = useOrgStore((s) => s.redo);
  const copyToClipboard = useOrgStore((s) => s.copyToClipboard);
  const pasteFromClipboard = useOrgStore((s) => s.pasteFromClipboard);
  const setToast = useOrgStore((s) => s.setToast);

  const updateSnapshot = useVersionsStore((s) => s.updateSnapshot);
  const versions = useVersionsStore((s) => s.versions);
  const viewOnly = useUiStore((s) => s.viewOnly);
  const currentUser = useAuthStore((s) => s.currentUser);

  const [showSave, setShowSave] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const deleteNode = useOrgStore((s) => s.deleteNode);
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const setShowLog = useUiStore((s) => s.setShowLog);

  // Resolve the loaded file's metadata. Confirmed files are normal files
  // with a "FIX" label — they can be edited and saved in place. Only
  // viewer-role and per-version read-only grants prevent overwrites.
  const currentFile = currentVersionId
    ? versions.find((v) => v.id === currentVersionId)
    : null;
  const isConfirmedFile = !!currentFile?.is_confirmed;
  const canOverwrite =
    !!currentVersionId && !viewOnly && currentUser?.role !== "viewer";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (isFromTextField(e.target)) return;

      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (key === "y" || (key === "z" && e.shiftKey)) {
        e.preventDefault();
        redo();
      } else if (key === "s") {
        e.preventDefault();
        if (canOverwrite) {
          handleOverwrite();
        } else {
          setShowSave(true);
        }
      } else if (key === "c") {
        if (!selectedId) {
          setToast({ kind: "error", message: "コピーするノードを選択してください" });
          return;
        }
        e.preventDefault();
        copyToClipboard(selectedId);
      } else if (key === "v") {
        e.preventDefault();
        pasteFromClipboard();
      } else if (key === "d") {
        if (!selectedId) return;
        e.preventDefault();
        const node = useOrgStore.getState().nodes.find((n) => n.id === selectedId);
        if (!node) return;
        const sameKindSiblings = useOrgStore
          .getState()
          .nodes.filter(
            (n) =>
              n.kind === node.kind &&
              n.parentId === node.parentId &&
              !n.isUnplaced,
          );
        const idx = sameKindSiblings.findIndex((s) => s.id === selectedId);
        duplicateAtPosition(selectedId, node.parentId, idx + 1);
      }
    }
    function onPlainKey(e: KeyboardEvent) {
      if (isFromTextField(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "Backspace" || e.key === "Delete") && selectedId) {
        e.preventDefault();
        deleteNode(selectedId, "cascade");
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onPlainKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onPlainKey);
    };
  }, [
    undo,
    redo,
    selectedId,
    copyToClipboard,
    pasteFromClipboard,
    setToast,
    duplicateAtPosition,
    deleteNode,
  ]);

  function handleCopy() {
    if (!selectedId) {
      setToast({ kind: "error", message: "コピーするノードを選択してください" });
      return;
    }
    copyToClipboard(selectedId);
  }

  async function handleOverwrite() {
    if (!currentVersionId || !canOverwrite) return;
    setSaving(true);
    const row = await updateSnapshot(currentVersionId, nodes);
    setSaving(false);
    if (!row) {
      setToast({ kind: "error", message: "保存に失敗しました" });
      return;
    }
    markClean({ versionId: row.id, versionLabel: row.name });
    setToast({ kind: "info", message: `「${row.name}」を上書き保存しました` });
  }

  function handleNewFile() {
    if (dirty) {
      const ok = window.confirm(
        "未保存の変更があります。新規ファイルを開くと変更は失われます。続けますか？",
      );
      if (!ok) return;
    }
    newFile();
  }

  return (
    <>
      <div className="toolbar">
        <span className={`toolbar__badge ${dirty ? "is-dirty" : "is-saved"}`}>
          <span className="toolbar__badgeDot" aria-hidden />
          {dirty
            ? versionLabel
              ? `編集中：${versionLabel}${isConfirmedFile ? "（確定版・マスター）" : ""}（未保存）`
              : "新規ファイル（未保存）"
            : versionLabel
              ? `保存済：${versionLabel}${isConfirmedFile ? "（確定版・マスター）" : ""}`
              : "新規ファイル"}
        </span>

        <div className="toolbar__spacer" />

        <button
          className="btn btn--ghost"
          onClick={handleCopy}
          disabled={!selectedId}
          title="選択中のノードと配下をコピー（Cmd/Ctrl+C）"
        >
          コピー
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => pasteFromClipboard()}
          disabled={!clipboard}
          title="クリップボードのノードを未配置エリアに貼り付け（Cmd/Ctrl+V）"
        >
          貼り付け
        </button>
        <div className="toolbar__divider" aria-hidden />
        <button
          className="btn btn--ghost"
          onClick={undo}
          disabled={past.length === 0}
          title="Cmd/Ctrl+Z"
        >
          ← 戻す
        </button>
        <button
          className="btn btn--ghost"
          onClick={redo}
          disabled={future.length === 0}
          title="Cmd/Ctrl+Shift+Z"
        >
          進む →
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowLog(true)}
          title="操作履歴を開く（任意の操作の直前の状態に復元できます）"
        >
          履歴
        </button>
        <div className="toolbar__divider" aria-hidden />
        <button
          className="btn btn--ghost"
          onClick={handleNewFile}
          title="新規ファイルを開く（保存するとサーバに登録されます）"
        >
          ＋新規
        </button>
        {canOverwrite ? (
          <>
            <button
              className="btn"
              onClick={() => setShowSave(true)}
              title="現在の内容を別の新しいファイルとして保存"
            >
              別名で保存
            </button>
            <button
              className="btn btn--primary"
              onClick={handleOverwrite}
              disabled={saving || !dirty}
              title="現在のファイルに上書き保存（Cmd/Ctrl+S）"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        ) : (
          <button
            className="btn btn--primary"
            onClick={() => setShowSave(true)}
            disabled={currentUser?.role === "viewer"}
            title={
              isConfirmedFile
                ? "確定版は上書きできません。サイドバーの「複製」から下書きを作成してください"
                : "新しいファイルとして保存（Cmd/Ctrl+S）"
            }
          >
            新規ファイルとして保存
          </button>
        )}
        <button
          className="btn"
          onClick={() => setShowShare(true)}
          title="閲覧専用の共有URLを発行"
        >
          🔗 共有
        </button>
      </div>
      {showSave && <SaveVersionDialog onClose={() => setShowSave(false)} />}
      {showShare && <ShareDialog onClose={() => setShowShare(false)} />}
    </>
  );
}
