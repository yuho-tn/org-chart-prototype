import { useEffect } from "react";
import { useOrgStore } from "../store/useOrgStore";

export function TopBar() {
  const dirty = useOrgStore((s) => s.dirty);
  const past = useOrgStore((s) => s.past);
  const future = useOrgStore((s) => s.future);
  const undo = useOrgStore((s) => s.undo);
  const redo = useOrgStore((s) => s.redo);
  const reset = useOrgStore((s) => s.reset);
  const save = useOrgStore((s) => s.save);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (meta && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (meta && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, save]);

  function handleReset() {
    if (confirm("初期データへリセットします。未保存の変更は破棄されます。よろしいですか？")) {
      reset();
    }
  }

  return (
    <header className="topbar">
      <div className="topbar__brand">OrgChart Studio</div>
      <span className={`topbar__badge ${dirty ? "is-dirty" : "is-saved"}`}>
        {dirty ? "編集中（未保存）" : "保存済"}
      </span>
      <div className="topbar__spacer" />
      <button className="btn btn--ghost" onClick={undo} disabled={past.length === 0} title="Cmd/Ctrl+Z">
        Undo
      </button>
      <button className="btn btn--ghost" onClick={redo} disabled={future.length === 0} title="Cmd/Ctrl+Shift+Z">
        Redo
      </button>
      <button className="btn btn--ghost" onClick={handleReset}>
        リセット
      </button>
      <button className="btn btn--primary" onClick={save} title="Cmd/Ctrl+S">
        保存
      </button>
    </header>
  );
}
