import { useUiStore } from "../../store/useUiStore";

/**
 * パルス領域内のサブナビ（ダッシュボード / アラート …）。
 * 「パルス」ヘッダータブ配下で複数ページを切り替える（section は共通 "pulse"）。
 * スライス5でコメントを追加予定。
 */
export function PulseSubnav({ active }: { active: "dashboard" | "alerts" | "comments" | "admin" }) {
  const navigate = useUiStore((s) => s.navigate);
  return (
    <nav className="psub" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={active === "dashboard"}
        className={"psub__tab" + (active === "dashboard" ? " is-active" : "")}
        onClick={() => navigate({ name: "pulse" })}
      >
        ダッシュボード
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "alerts"}
        className={"psub__tab" + (active === "alerts" ? " is-active" : "")}
        onClick={() => navigate({ name: "pulse_alerts" })}
      >
        アラート
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "comments"}
        className={"psub__tab" + (active === "comments" ? " is-active" : "")}
        onClick={() => navigate({ name: "pulse_comments" })}
      >
        コメント
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={active === "admin"}
        className={"psub__tab" + (active === "admin" ? " is-active" : "")}
        onClick={() => navigate({ name: "pulse_admin" })}
      >
        設定
      </button>
    </nav>
  );
}

export default PulseSubnav;
