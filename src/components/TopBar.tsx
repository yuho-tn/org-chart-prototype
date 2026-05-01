import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import { SaveVersionDialog } from "./SaveVersionDialog";
import { ShareDialog } from "./ShareDialog";
import { getAuthor, setAuthor } from "../lib/author";

function isFromTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

export function TopBar() {
  const dirty = useOrgStore((s) => s.dirty);
  const versionLabel = useOrgStore((s) => s.currentVersionLabel);
  const selectedId = useOrgStore((s) => s.selectedId);
  const clipboard = useOrgStore((s) => s.clipboard);
  const past = useOrgStore((s) => s.past);
  const future = useOrgStore((s) => s.future);
  const undo = useOrgStore((s) => s.undo);
  const redo = useOrgStore((s) => s.redo);
  const reset = useOrgStore((s) => s.reset);
  const copyToClipboard = useOrgStore((s) => s.copyToClipboard);
  const pasteFromClipboard = useOrgStore((s) => s.pasteFromClipboard);
  const setToast = useOrgStore((s) => s.setToast);

  const [showSave, setShowSave] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const deleteNode = useOrgStore((s) => s.deleteNode);
  const duplicateAtPosition = useOrgStore((s) => s.duplicateAtPosition);
  const setShowLog = useUiStore((s) => s.setShowLog);
  const setShowUsers = useUiStore((s) => s.setShowUsers);
  const setShowEmployees = useUiStore((s) => s.setShowEmployees);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Skip when the user is typing in an input / textarea / chip rename — let
      // the browser handle the native clipboard behavior on text content.
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
        setShowSave(true);
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
        // Cmd+D : duplicate selected next to itself.
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

  function handleReset() {
    if (confirm("初期データへリセットします。未保存の変更は破棄されます。よろしいですか？")) {
      reset();
    }
  }

  function handleChangeAuthor() {
    const current = getAuthor() ?? "";
    const next = window.prompt("作成者の表示名を変更します", current);
    if (next === null) return;
    if (next.trim()) setAuthor(next.trim());
  }

  function handleCopy() {
    if (!selectedId) {
      setToast({ kind: "error", message: "コピーするノードを選択してください" });
      return;
    }
    copyToClipboard(selectedId);
  }

  return (
    <>
      <header className="topbar">
        <div className="topbar__brand">OrgChart Studio</div>
        <span className={`topbar__badge ${dirty ? "is-dirty" : "is-saved"}`}>
          {dirty ? "編集中（未保存）" : versionLabel ? `保存済：${versionLabel}` : "未保存"}
        </span>
        <div className="topbar__spacer" />
        <button
          className="btn btn--ghost btn--xs"
          onClick={handleChangeAuthor}
          title="作成者の名前を変更"
        >
          {getAuthor() ?? "名前未設定"} ▾
        </button>
        <div className="topbar__divider" aria-hidden />
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
        <div className="topbar__divider" aria-hidden />
        <button className="btn btn--ghost" onClick={undo} disabled={past.length === 0} title="Cmd/Ctrl+Z">
          Undo
        </button>
        <button
          className="btn btn--ghost"
          onClick={redo}
          disabled={future.length === 0}
          title="Cmd/Ctrl+Shift+Z"
        >
          Redo
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowLog(true)}
          title="操作履歴を開く（任意の操作の直前の状態に復元できます）"
        >
          履歴
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowEmployees(true)}
          title="従業員名簿（マスター管理）を開く"
        >
          従業員
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => setShowUsers(true)}
          title="このツールの利用ユーザーを管理"
        >
          ユーザー
        </button>
        <button className="btn btn--ghost" onClick={handleReset}>
          リセット
        </button>
        <button
          className="btn btn--primary"
          onClick={() => setShowSave(true)}
          title="Cmd/Ctrl+S"
        >
          バージョン保存
        </button>
        <button
          className="btn"
          onClick={() => setShowShare(true)}
          title="閲覧専用の共有URLを発行"
        >
          🔗 共有
        </button>
      </header>
      {showSave && <SaveVersionDialog onClose={() => setShowSave(false)} />}
      {showShare && <ShareDialog onClose={() => setShowShare(false)} />}
    </>
  );
}
