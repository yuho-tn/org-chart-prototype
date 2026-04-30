import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { SaveVersionDialog } from "./SaveVersionDialog";
import { getAuthor, setAuthor } from "../lib/author";

export function TopBar() {
  const dirty = useOrgStore((s) => s.dirty);
  const versionLabel = useOrgStore((s) => s.currentVersionLabel);
  const past = useOrgStore((s) => s.past);
  const future = useOrgStore((s) => s.future);
  const undo = useOrgStore((s) => s.undo);
  const redo = useOrgStore((s) => s.redo);
  const reset = useOrgStore((s) => s.reset);

  const [showSave, setShowSave] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        meta &&
        (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        e.preventDefault();
        redo();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setShowSave(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

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
      </header>
      {showSave && <SaveVersionDialog onClose={() => setShowSave(false)} />}
    </>
  );
}
