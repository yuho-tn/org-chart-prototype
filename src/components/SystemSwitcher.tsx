import { useUiStore, systemOfRoute, type SystemKey } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { canAccessPayroll } from "../lib/supabase";

type SystemTab = {
  id: SystemKey;
  label: string;
  icon: string;
  /** When false, the tab is hidden (not just disabled) — Payroll should
   *  not even hint at its existence for users without permission. */
  visible: boolean;
};

/**
 * Top-level system switcher. Sits ABOVE the GlobalHeader. Toggles between
 * the TalentHub app (organisational charts / employees / users) and the
 * Payroll app (給与表 / 等級マスター / 監査ログ).
 *
 * Switching swaps the entire header below — different tabs, different
 * accent colors — and short-fades the content via `systemSwitching`.
 * Payroll is hidden entirely for users without payroll access.
 */
export function SystemSwitcher() {
  const route = useUiStore((s) => s.route);
  const switchSystem = useUiStore((s) => s.switchSystem);
  const currentSystem = systemOfRoute(route);

  const role = useAuthStore((s) => s.currentUser?.role);
  const payrollAllowed = canAccessPayroll(role);

  const tabs: SystemTab[] = [
    { id: "talenthub", label: "TalentHub", icon: "📊", visible: true },
    { id: "payroll", label: "Payroll", icon: "💰", visible: payrollAllowed },
  ];

  const visibleTabs = tabs.filter((t) => t.visible);
  // If the only visible system is TalentHub, hide the switcher entirely —
  // showing a single tab is just noise.
  if (visibleTabs.length <= 1) return null;

  return (
    <div className="sysswitch" role="tablist" aria-label="システム切替">
      <span className="sysswitch__brand" aria-hidden>
        ▣ Sho-san
      </span>
      <span className="sysswitch__divider" aria-hidden />
      <div className="sysswitch__tabs">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={currentSystem === t.id}
            className={`sysswitch__tab ${currentSystem === t.id ? "is-active" : ""} sysswitch__tab--${t.id}`}
            onClick={() => switchSystem(t.id)}
            title={t.label}
          >
            <span className="sysswitch__tabIcon" aria-hidden>{t.icon}</span>
            <span className="sysswitch__tabLabel">{t.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
