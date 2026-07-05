import {
  useUiStore,
  sectionOfRoute,
  systemOfRoute,
  defaultRouteForSection,
  type Section,
  type SystemKey,
} from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { canManagePermissions, type AppUserRole } from "../lib/supabase";

const TABS_BY_SYSTEM: Record<SystemKey, { id: Section; label: string; icon: string }[]> = {
  talenthub: [
    { id: "org", label: "組織図", icon: "🗂" },
    { id: "employees", label: "従業員マスター", icon: "👥" },
    // ミッションは全ログインユーザーに表示（自分のシートがあるため）
    { id: "missions", label: "ミッション", icon: "🎯" },
    { id: "users", label: "ユーザー", icon: "🔑" },
    // 権限管理は master / privileged_admin のみ表示（下のフィルタ参照）
    { id: "permissions", label: "権限", icon: "🛡" },
  ],
  payroll: [
    { id: "salary", label: "給与表", icon: "📋" },
    { id: "grades", label: "等級マスター", icon: "🏷" },
    { id: "audit_log", label: "監査ログ", icon: "📜" },
  ],
};

const BRAND_BY_SYSTEM: Record<SystemKey, { name: string; sub: string }> = {
  talenthub: { name: "TalentHub", sub: "組織図 & 従業員管理" },
  payroll: { name: "Payroll", sub: "給与・査定" },
};

const ROLE_LABEL: Record<AppUserRole, string> = {
  master: "master",
  privileged_admin: "特権管理者",
  admin: "admin",
  editor: "editor",
  viewer: "viewer",
};

/**
 * Always-on top-level header for the app shell. Renders different tabs
 * depending on the active system (TalentHub vs Payroll). When in the
 * Payroll system, the header adopts an amber gradient so the user is
 * never confused about which system they are looking at.
 *
 * Sits BELOW the SystemSwitcher and ABOVE the section-specific subnavs
 * (see OrgSubNav etc.).
 */
export function GlobalHeader() {
  const route = useUiStore((s) => s.route);
  const navigate = useUiStore((s) => s.navigate);
  const currentSection = sectionOfRoute(route);
  const currentSystem = systemOfRoute(route);
  const currentUser = useAuthStore((s) => s.currentUser);
  // 権限管理タブは master / privileged_admin のみ（SystemSwitcher の
  // payroll ゲートと同じパターン）。
  const tabs = TABS_BY_SYSTEM[currentSystem].filter(
    (t) => t.id !== "permissions" || canManagePermissions(currentUser?.role),
  );
  const brand = BRAND_BY_SYSTEM[currentSystem];
  const signOut = useAuthStore((s) => s.signOut);

  async function handleSignOut() {
    if (!confirm("サインアウトしますか？")) return;
    await signOut();
    window.location.reload();
  }

  return (
    <header className={`ghdr ghdr--${currentSystem}`}>
      <div className="ghdr__brand">
        <span className="ghdr__brandMark" aria-hidden>▣</span>
        <span className="ghdr__brandName">{brand.name}</span>
        <span className="ghdr__brandSub">{brand.sub}</span>
      </div>

      <nav className="ghdr__tabs" role="tablist">
        {tabs.map((t) => (
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
              {ROLE_LABEL[currentUser.role] ?? currentUser.role}
            </span>
          </span>
        </button>
      )}
    </header>
  );
}
