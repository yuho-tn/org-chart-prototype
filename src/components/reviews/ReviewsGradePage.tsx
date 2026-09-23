import { useState } from "react";
import { ReviewsSubnav } from "./ReviewsSubnav";
import {
  GRADES,
  GRADE_ENGINE,
  GRADE_READING,
  rankOf,
  type RankKey,
} from "../../lib/reviewsContent";

/**
 * グレード基準（16段階）ページ（#/reviews/grade）。
 * 16グレード表（上M〜下P1・月給基準額込み）＋昇格エンジン＋グレードの読み方。
 */
export function ReviewsGradePage() {
  const [openCode, setOpenCode] = useState<string | null>(null);

  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="grade" />
        <header className="page__header reviews__header">
          <h1 className="page__title">グレード基準（16段階）</h1>
          <p className="page__subtitle">
            グレード＝任せられる仕事の大きさ（量）。「どんな難度のミッションを、どこまで自分の力でやり切ったか」で上がり、月給基準額に直結します。
          </p>
        </header>

        {/* 昇格エンジン */}
        <section className="reviews__section">
          <h2 className="reviews__h2">グレード共通の進化エンジン</h2>
          <p className="reviews__lead">
            1〜5の意味はどのランクでも同じです。
          </p>
          <div className="reviews__engine">
            {GRADE_ENGINE.map((e, i) => (
              <div key={e.no} className="reviews__engineStep">
                <span className="reviews__engineNo">{e.no}</span>
                <span className="reviews__engineLabel">{e.label}</span>
                <span className="reviews__engineDesc">{e.desc}</span>
                {i < GRADE_ENGINE.length - 1 && (
                  <span className="reviews__engineArrow" aria-hidden>
                    →
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="reviews__note">
            昇格（＋1号）＝「卒業要件を織り込んだミッションの達成」。達成は自動ではなく、未達期は0号が原則です。詳細は「昇格・判定ルール集」へ。
          </p>
        </section>

        {/* 16グレード表 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">16グレード基準（上M〜下P1）</h2>
          <p className="reviews__lead">行をクリックすると昇格基準が開きます。</p>
          <div className="reviews__gradeTable">
            {GRADES.map((g) => {
              const rank = rankOf(g.rank as RankKey);
              const open = openCode === g.code;
              return (
                <div key={g.code} className={`reviews__gradeRow reviews__gradeRow--${g.rank}`}>
                  <button
                    className="reviews__gradeRowHead"
                    onClick={() => setOpenCode(open ? null : g.code)}
                    aria-expanded={open}
                  >
                    <span className={`reviews__gradeCode reviews__gradeCode--${g.rank}`}>
                      {g.code}
                    </span>
                    <span className="reviews__gradeRankName">{rank.name}</span>
                    <span className="reviews__gradeTitle">{g.title}</span>
                    <span className="reviews__gradeSalary">{g.salary}</span>
                    <span className="reviews__calloutChev" aria-hidden>
                      {open ? "−" : "+"}
                    </span>
                  </button>
                  <div className="reviews__gradeBody" hidden={!open}>
                    <p className="reviews__gradeText">{g.body}</p>
                    <p className="reviews__gradePromo">
                      <span className="reviews__gradePromoLabel">昇格基準</span>
                      {g.promotion}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* グレードの読み方 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">グレードの読み方</h2>
          <div className="reviews__ruleList">
            {GRADE_READING.map((r) => (
              <div key={r.title} className="reviews__rule">
                <span className="reviews__ruleTitle">{r.title}</span>
                <span className="reviews__ruleBody">{r.body}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
  );
}

export default ReviewsGradePage;
