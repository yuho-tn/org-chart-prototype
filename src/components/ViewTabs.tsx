import { useUiStore, type OrgView } from "../store/useUiStore";

const TABS: { id: OrgView; label: string; icon: string; tip: string }[] = [
  { id: "tree", label: "組織図ツリー", icon: "⌬", tip: "ツリー形式（編集向け）" },
  { id: "list", label: "組織図リスト", icon: "≡", tip: "リスト形式（PDF・印刷向け）" },
  { id: "assignments", label: "配属一覧", icon: "👥", tip: "配置メンバーの主務／兼務を一覧" },
];

export function ViewTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);

  return (
    <div className="view-tabs" role="tablist">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          className={`view-tab ${view === t.id ? "is-active" : ""}`}
          onClick={() => setView(t.id)}
          title={t.tip}
        >
          <span className="view-tab__icon" aria-hidden>{t.icon}</span>
          {t.label}
        </button>
      ))}
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
