import { useUiStore } from "../store/useUiStore";

export function ViewTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <div className="view-tabs" role="tablist">
      <button
        role="tab"
        aria-selected={view === "tree"}
        className={`view-tab ${view === "tree" ? "is-active" : ""}`}
        onClick={() => setView("tree")}
        title="ツリー形式（編集向け）"
      >
        <span className="view-tab__icon" aria-hidden>⌬</span>
        ツリー
      </button>
      <button
        role="tab"
        aria-selected={view === "list"}
        className={`view-tab ${view === "list" ? "is-active" : ""}`}
        onClick={() => setView("list")}
        title="リスト形式（PDF・印刷向け）"
      >
        <span className="view-tab__icon" aria-hidden>≡</span>
        リスト
      </button>
      <div className="view-tabs__spacer" />
      {view === "list" && (
        <button
          className="btn btn--ghost btn--xs"
          onClick={() => window.print()}
          title="ブラウザの印刷ダイアログを開く（PDF保存もここから）"
        >
          🖶 印刷 / PDF
        </button>
      )}
    </div>
  );
}
