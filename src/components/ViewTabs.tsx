import { useUiStore, type OrgView } from "../store/useUiStore";

/**
 * 体制図セクションのタブ。
 * 左3つ＝体制図系（全メンバーの所属）、右2つ＝権限系（2026-08-05 MTGで追加）。
 * 目的が違う面なので、区切り線を挟んで並べる。
 */
const TABS: {
  id: OrgView;
  label: string;
  icon: string;
  tip: string;
  group: "structure" | "authority";
  /** 共有リンク（匿名閲覧）では出さないタブ */
  loginOnly?: boolean;
}[] = [
  { id: "tree", label: "体制図", icon: "⌬", tip: "ツリー形式（編集向け）", group: "structure" },
  { id: "list", label: "体制図リスト", icon: "≡", tip: "リスト形式（PDF・印刷向け）", group: "structure" },
  { id: "assignments", label: "配属一覧", icon: "👥", tip: "配置メンバーの主務／兼務を一覧", group: "structure" },
  {
    id: "authority",
    label: "組織図",
    icon: "⚖",
    tip: "マネージャー以上の権限図（決裁を誰に上げるか）",
    group: "authority",
  },
  {
    id: "ml",
    label: "ML規定",
    icon: "📋",
    tip: "役職別の決裁権限表（マネージャー・リーダー規定）",
    group: "authority",
    loginOnly: true,
  },
];

export function ViewTabs() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const viewOnly = useUiStore((s) => s.viewOnly);

  // ML規定は決裁金額を含む社内規定なので、匿名の共有リンクには出さない。
  const tabs = TABS.filter((t) => !(t.loginOnly && viewOnly));

  return (
    <div className="view-tabs" role="tablist">
      {tabs.map((t, i) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          className={`view-tab ${view === t.id ? "is-active" : ""} ${
            t.group === "authority" && tabs[i - 1]?.group === "structure"
              ? "view-tab--groupstart"
              : ""
          }`}
          onClick={() => setView(t.id)}
          title={t.tip}
        >
          <span className="view-tab__icon" aria-hidden>{t.icon}</span>
          {t.label}
        </button>
      ))}
      <div className="view-tabs__spacer" />
      {(view === "list" || view === "ml" || view === "authority") && (
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
