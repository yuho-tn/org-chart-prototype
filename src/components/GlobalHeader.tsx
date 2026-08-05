import { useEffect, useRef, useState } from "react";
import {
  Home,
  Network,
  Users,
  Target,
  CloudSun,
  KeyRound,
  ShieldCheck,
  Wallet,
  LayoutGrid,
  LogOut,
  ChevronDown,
  ClipboardList,
  Tags,
  ScrollText,
  Award,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import {
  useUiStore,
  sectionOfRoute,
  systemOfRoute,
  defaultRouteForSection,
  defaultRouteForSystem,
  type Section,
  type SystemKey,
} from "../store/useUiStore";
import { useAuthStore, isUserManager } from "../store/useAuthStore";
import {
  canManagePermissions,
  canAccessPayroll,
  canAccessPulse,
  type AppUserRole,
} from "../lib/supabase";

/**
 * P1 IA再設計:
 * - ヘッダーは1本（旧 SystemSwitcher 行は廃止・ブランド表記は左上の1箇所のみ）
 * - メインナビは利用頻度の高い5つ（ホーム/組織図/メンバー/ミッション/パルス）
 * - 管理系（ユーザー管理・権限管理・Payroll切替・サインアウト）は右上の
 *   ユーザーメニュー（ドロップダウン）へ収容
 */
const TABS_BY_SYSTEM: Record<
  SystemKey,
  { id: Section; label: string; Icon: LucideIcon }[]
> = {
  talenthub: [
    { id: "home", label: "ホーム", Icon: Home },
    // セクション名は「体制図」。配下タブに権限図としての「組織図」を持つため、
    // 上位の呼称と衝突しないよう 2026-08-05 のMTGで改称した（URLは #/org のまま）。
    { id: "org", label: "体制図", Icon: Network },
    { id: "employees", label: "メンバー", Icon: Users },
    // ミッションは全ログインユーザーに表示（自分のシートがあるため）
    { id: "missions", label: "ミッション", Icon: Target },
    // 評価制度は全ログインユーザーに表示（静的コンテンツ）
    { id: "reviews", label: "評価制度", Icon: Award },
    // AIレベルは全ログインユーザーに表示（個人レベルは全社フルオープン）
    { id: "ailevel", label: "AIレベル", Icon: Sparkles },
    // パルス ダッシュボードは master/privileged_admin のみ表示（下のフィルタ参照）
    { id: "pulse", label: "パルス", Icon: CloudSun },
  ],
  payroll: [
    { id: "salary", label: "給与表", Icon: ClipboardList },
    { id: "grades", label: "等級マスター", Icon: Tags },
    { id: "audit_log", label: "監査ログ", Icon: ScrollText },
  ],
};

const ROLE_LABEL: Record<AppUserRole, string> = {
  master: "master",
  privileged_admin: "特権管理者",
  admin: "admin",
  editor: "editor",
  viewer: "viewer",
};

/** ユーザーメニュー内に置く管理系セクション（users / permissions）。 */
const MENU_SECTIONS: Section[] = ["users", "permissions"];

export function GlobalHeader() {
  const route = useUiStore((s) => s.route);
  const navigate = useUiStore((s) => s.navigate);
  const switchSystem = useUiStore((s) => s.switchSystem);
  const currentSection = sectionOfRoute(route);
  const currentSystem = systemOfRoute(route);
  const currentUser = useAuthStore((s) => s.currentUser);
  const signOut = useAuthStore((s) => s.signOut);
  const role = currentUser?.role;

  const tabs = TABS_BY_SYSTEM[currentSystem].filter(
    (t) => t.id !== "pulse" || canAccessPulse(role),
  );

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 外側クリック / Escape でメニューを閉じる
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    if (!confirm("サインアウトしますか？")) return;
    await signOut();
    window.location.reload();
  }

  function goMenu(section: Section) {
    setMenuOpen(false);
    navigate(defaultRouteForSection(section));
  }

  const menuActive = MENU_SECTIONS.includes(currentSection);

  return (
    <header className={`ghdr ghdr--${currentSystem}`}>
      <button
        type="button"
        className="ghdr__brand"
        onClick={() => navigate(defaultRouteForSystem(currentSystem))}
        title="ホームへ"
      >
        <span className="ghdr__brandMark" aria-hidden>
          <Network size={16} strokeWidth={2.4} />
        </span>
        <span className="ghdr__brandName">
          {currentSystem === "payroll" ? "Payroll" : "TalentHub"}
        </span>
        {currentSystem === "payroll" && (
          <span className="ghdr__sysChip">給与・査定</span>
        )}
      </button>

      <nav className="ghdr__tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={currentSection === t.id}
            className={`ghdr__tab ${currentSection === t.id ? "is-active" : ""}`}
            onClick={() => navigate(defaultRouteForSection(t.id))}
          >
            <span className="ghdr__tabIcon" aria-hidden>
              <t.Icon size={15} strokeWidth={2} />
            </span>
            {t.label}
          </button>
        ))}
      </nav>

      <div className="ghdr__spacer" />

      {currentUser && (
        <div className="ghdr__menuWrap" ref={menuRef}>
          <button
            className={`ghdr__user ${menuActive || menuOpen ? "is-active" : ""}`}
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="アカウントメニュー"
          >
            <span className="ghdr__avatar" aria-hidden>
              {(currentUser.display_name ?? currentUser.email)[0]?.toUpperCase() ?? "?"}
            </span>
            <span className="ghdr__userInfo">
              <span className="ghdr__userName">
                {currentUser.display_name ?? currentUser.email}
              </span>
              <span className={`ghdr__userRole ghdr__userRole--${currentUser.role}`}>
                {ROLE_LABEL[currentUser.role] ?? currentUser.role}
              </span>
            </span>
            <span className={`ghdr__chevron ${menuOpen ? "is-open" : ""}`} aria-hidden>
              <ChevronDown size={14} strokeWidth={2} />
            </span>
          </button>

          {menuOpen && (
            <div className="ghdrmenu" role="menu">
              {isUserManager(role) && (
                <button
                  className={`ghdrmenu__item ${currentSection === "users" ? "is-active" : ""}`}
                  role="menuitem"
                  onClick={() => goMenu("users")}
                >
                  <KeyRound size={15} strokeWidth={2} />
                  ユーザー管理
                </button>
              )}
              {canManagePermissions(role) && (
                <button
                  className={`ghdrmenu__item ${currentSection === "permissions" ? "is-active" : ""}`}
                  role="menuitem"
                  onClick={() => goMenu("permissions")}
                >
                  <ShieldCheck size={15} strokeWidth={2} />
                  権限管理
                </button>
              )}
              {canAccessPayroll(role) && (
                <>
                  <div className="ghdrmenu__divider" role="separator" />
                  {currentSystem === "talenthub" ? (
                    <button
                      className="ghdrmenu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        switchSystem("payroll");
                      }}
                    >
                      <Wallet size={15} strokeWidth={2} />
                      Payroll（給与・査定）
                    </button>
                  ) : (
                    <button
                      className="ghdrmenu__item"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        switchSystem("talenthub");
                      }}
                    >
                      <LayoutGrid size={15} strokeWidth={2} />
                      TalentHub へ戻る
                    </button>
                  )}
                </>
              )}
              <div className="ghdrmenu__divider" role="separator" />
              <button
                className="ghdrmenu__item ghdrmenu__item--danger"
                role="menuitem"
                onClick={handleSignOut}
              >
                <LogOut size={15} strokeWidth={2} />
                サインアウト
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}
