import { useState } from "react";
import { ReviewsSubnav } from "./ReviewsSubnav";
import { RULE_CATEGORIES } from "../../lib/reviewsContent";

/**
 * 昇格・判定ルール集ページ（#/reviews/rules）。
 * 「揉めた時に開くページ」— カテゴリ別アコーディオンでFAQ的に引ける形。
 */
export function ReviewsRulesPage() {
  const [open, setOpen] = useState<string | null>(RULE_CATEGORIES[0]?.key ?? null);

  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="rules" />
        <header className="page__header reviews__header">
          <h1 className="page__title">昇格・判定ルール集</h1>
          <p className="page__subtitle">
            評価・昇格で迷った時／揉めた時に開くページ。判定の細則をカテゴリ別にまとめています。
          </p>
        </header>

        <section className="reviews__section">
          {RULE_CATEGORIES.map((cat) => {
            const isOpen = open === cat.key;
            return (
              <div key={cat.key} className="reviews__ruleCat">
                <button
                  className="reviews__ruleCatHead"
                  onClick={() => setOpen(isOpen ? null : cat.key)}
                  aria-expanded={isOpen}
                >
                  <span className="reviews__ruleCatTitle">{cat.title}</span>
                  <span className="reviews__ruleCatCount">{cat.rules.length}項目</span>
                  <span className="reviews__calloutChev" aria-hidden>
                    {isOpen ? "−" : "+"}
                  </span>
                </button>
                {isOpen && (
                  <div className="reviews__ruleList reviews__ruleList--cat">
                    {cat.rules.map((r) => (
                      <div key={r.title} className="reviews__rule">
                        <span className="reviews__ruleTitle">{r.title}</span>
                        <span className="reviews__ruleBody">{r.body}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>

        <p className="reviews__note">
          ここに書かれていないケースの裁定はキャリブレーション会議が行い、裁定結果は「基準例集」として蓄積・共有されます。
        </p>
      </main>
  );
}

export default ReviewsRulesPage;
