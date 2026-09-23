import { useEffect } from "react";
import { useUiStore } from "../../store/useUiStore";
import { usePulseMembersStore } from "../../store/usePulseMembersStore";

/**
 * パルス領域内のサブナビ（ダッシュボード / メンバー / アラート / コメント / 設定）。
 * 「パルス」ヘッダータブ配下で複数ページを切り替える（section は共通 "pulse"）。
 * 「メンバー」タブは実名閲覧権限者（pulse_can_view_realname）のみ表示。
 */
export function PulseSubnav({
  active,
}: {
  active: "dashboard" | "members" | "alerts" | "comments" | "admin";
}) {
  const navigate = useUiStore((s) => s.navigate);
  const canViewRealname = usePulseMembersStore((s) => s.canViewRealname);
  const checkRealname = usePulseMembersStore((s) => s.checkRealname);

  useEffect(() => {
    checkRealname();
  }, [checkRealname]);

  const tab = (
    key: "dashboard" | "members" | "alerts" | "comments" | "admin",
    label: string,
    onClick: () => void,
  ) => (
    <button
      type="button"
      role="tab"
      aria-selected={active === key}
      className={"psub__tab" + (active === key ? " is-active" : "")}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <nav className="psub" role="tablist">
      {tab("dashboard", "ダッシュボード", () => navigate({ name: "pulse" }))}
      {canViewRealname === true &&
        tab("members", "メンバー", () => navigate({ name: "pulse_members" }))}
      {tab("alerts", "アラート", () => navigate({ name: "pulse_alerts" }))}
      {tab("comments", "コメント", () => navigate({ name: "pulse_comments" }))}
      {tab("admin", "設定", () => navigate({ name: "pulse_admin" }))}
    </nav>
  );
}

export default PulseSubnav;
