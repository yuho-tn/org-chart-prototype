import { useUiStore, sectionOfRoute, defaultRouteForSection, type Section } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";

const PRIMARY_TABS: { id: Section; label: string; icon: string }[] = [
  { id: "org", label: "組織図", icon: "🗂" },
  { id: "employees", label: "従業員マスター", icon: "👥" },
  { id: "users", label: "ユーザー", icon: "🔑" },
];

/**
 * Always-on top-level header for the app shell. Shows the three primary
 * sections (組織図 / 従業員マスター / ユーザー) and the signed-in user pill
 * on the right. Section-specific actions live in a secondary header below
 * (see OrgSubNav / TopBar).
 */
export function GlobalHeader() {
  const route = useUiStore((s) => s.route);
  const navigate = useUiStore((s) => s.navigate);
  const currentSection = sectionOfRoute(route);
  const currentUser = useAuthStore((s) => s.currentUser);
  const signOut = useAuthStore((s) => s.signOut);

  function handleSignOut() {
    if (!confirm("サインアウトしますか？")) return;
    signOut();
    window.location.reload();
  }

  return (
    <header className="ghdr">
      <div className="ghdr__brand">
        <span className="ghdr__brandMark" aria-hidden>▣</span>
        <span className="ghdr__brandName">TalentHub</span>
        <span className="ghdr__brandSub">組織図 &amp; 従業員管理</span>
      </div>

      <nav className="ghdr__tabs" role="tablist">
        {PRIMARY_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={currentSection === t.id}
            className={`ghdr__tab ${currentSection === t.id ? "is-active" : ""}`}
            onClick={() => navigate(defaultRouteForSection(t.id))}
          >
            <span className="ghdr__tabIcon" aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="ghdr__spacer" />

      {currentUser && (
        <button
          className="ghdr__user"
          onClick={handleSignOut}
          title="クリックでサインアウト"
        >
          <span className="ghdr__avatar" aria-hidden>
            {(currentUser.display_name ?? currentUser.email)[0]?.toUpperCase() ?? "?"}
          </span>
          <span className="ghdr__userInfo">
            <span className="ghdr__userName">{currentUser.display_name ?? currentUser.email}</span>
            <span className={`ghdr__userRole ghdr__userRole--${currentUser.role}`}>
              {currentUser.role}
            </span>
          </span>
        </button>
      )}
    </header>
  );
}
