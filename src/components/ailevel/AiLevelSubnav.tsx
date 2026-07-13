import { useUiStore } from "../../store/useUiStore";
import { useAuthStore } from "../../store/useAuthStore";
import { canManagePermissions } from "../../lib/supabase";

export type AiLevelTab = "dashboard" | "admin";

/**
 * AIレベルセクションのサブナビ。ReviewsSubnav と同じ .psub スタイルを流用。
 * 「認定管理」タブは管理者（master / privileged_admin）のみ表示。
 */
export function AiLevelSubnav({ active }: { active: AiLevelTab }) {
  const navigate = useUiStore((s) => s.navigate);
  const role = useAuthStore((s) => s.currentUser?.role);
  const tabs: { id: AiLevelTab; label: string; route: { name: "ailevel" | "ailevel_admin" } }[] = [
    { id: "dashboard", label: "分布", route: { name: "ailevel" } },
    ...(canManagePermissions(role)
      ? ([{ id: "admin", label: "認定管理", route: { name: "ailevel_admin" } }] as const)
      : []),
  ];
  return (
    <nav className="psub psub--scroll" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={active === t.id}
          className={"psub__tab" + (active === t.id ? " is-active" : "")}
          onClick={() => navigate(t.route)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

export default AiLevelSubnav;
