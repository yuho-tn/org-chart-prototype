import { useUiStore } from "../../store/useUiStore";

export type ReviewsTab = "overview" | "rank" | "grade" | "flow" | "rules";

const TABS: { id: ReviewsTab; label: string; route: Parameters<ReturnType<typeof useUiStore.getState>["navigate"]>[0] }[] = [
  { id: "overview", label: "制度の全体像", route: { name: "reviews" } },
  { id: "rank", label: "ランク基準（13軸）", route: { name: "reviews_rank" } },
  { id: "grade", label: "グレード基準（16段階）", route: { name: "reviews_grade" } },
  { id: "flow", label: "評価の流れ", route: { name: "reviews_flow" } },
  { id: "rules", label: "昇格・判定ルール集", route: { name: "reviews_rules" } },
];

/**
 * 人事評価制度セクションのサブナビ。PulseSubnav と同じ .psub スタイルを流用し、
 * section は共通 "reviews" のままサブページを切り替える。
 */
export function ReviewsSubnav({ active }: { active: ReviewsTab }) {
  const navigate = useUiStore((s) => s.navigate);
  return (
    <nav className="psub psub--scroll" role="tablist">
      {TABS.map((t) => (
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

export default ReviewsSubnav;
