import { useState } from "react";
import { ReviewsSubnav } from "./ReviewsSubnav";
import {
  CREDO_AXES,
  SENSE_AXES,
  JUDGE_RULES,
  RANK_PROMOTIONS,
  RANK_PROMOTION_PRINCIPLE,
  RANK_PROMOTION_NOTES,
  RANK_ORDER,
  rankOf,
  type AxisCell,
  type RankKey,
} from "../../lib/reviewsContent";

/**
 * ランク基準（13軸）ページ（#/reviews/rank）。
 * CREDO7軸⇄6SENSE6軸の切替タブ＋軸単位カード（巨大表をそのまま出さない）。
 * 各軸＝進化ストーリー＋4ランクのセル（【タイトル】【本文】【基準例】）。
 */
export function ReviewsRankPage() {
  const [tab, setTab] = useState<"credo" | "sense">("credo");
  const [openJudge, setOpenJudge] = useState(false);

  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="rank" />
        <header className="page__header reviews__header">
          <h1 className="page__title">ランク基準（13軸）</h1>
          <p className="page__subtitle">
            ランク＝人としての水準（質）。CREDO7軸（在り方）と6SENSE6軸（能力）の計13軸で、
            「どのランクの水準で仕事に向かっているか」を判定します。
          </p>
        </header>

        {/* 判定ルール */}
        <section className="reviews__callout">
          <button
            className="reviews__calloutHead"
            onClick={() => setOpenJudge((v) => !v)}
            aria-expanded={openJudge}
          >
            <span className="reviews__calloutTitle">
              まず読んでください：基準例は「例示」であり「要件」ではありません
            </span>
            <span className="reviews__calloutChev" aria-hidden>
              {openJudge ? "−" : "+"}
            </span>
          </button>
          {openJudge && (
            <div className="reviews__calloutBody">
              {JUDGE_RULES.map((r) => (
                <div key={r.title} className="reviews__rule">
                  <span className="reviews__ruleTitle">{r.title}</span>
                  <span className="reviews__ruleBody">{r.body}</span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* CREDO / 6SENSE 切替 */}
        <div className="reviews__axisTabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "credo"}
            className={"reviews__axisTab" + (tab === "credo" ? " is-active" : "")}
            onClick={() => setTab("credo")}
          >
            CREDO<span className="reviews__axisTabSub">在り方・7軸</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "sense"}
            className={"reviews__axisTab" + (tab === "sense" ? " is-active" : "")}
            onClick={() => setTab("sense")}
          >
            6SENSE<span className="reviews__axisTabSub">能力・6軸</span>
          </button>
        </div>

        {tab === "credo" ? (
          <section className="reviews__axes">
            {CREDO_AXES.map((axis) => (
              <AxisBlock
                key={axis.key}
                badge={<span className="reviews__credoBadge">CREDO.{axis.credoNo}</span>}
                name={axis.name}
                sub={axis.credoPhrase}
                story={axis.story}
                cells={axis.cells}
              />
            ))}
          </section>
        ) : (
          <section className="reviews__axes">
            {SENSE_AXES.map((axis) => (
              <AxisBlock
                key={axis.key}
                badge={
                  <span
                    className="reviews__senseBadge"
                    style={{ ["--chip" as string]: axis.color, ["--chipSoft" as string]: axis.colorSoft }}
                  >
                    {axis.en}
                  </span>
                }
                name={axis.name}
                sub={axis.catch}
                tags={axis.tags}
                accent={axis.color}
                story={axis.story}
                cells={axis.cells}
              />
            ))}
          </section>
        )}

        {/* ランク昇格基準 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">ランク昇格基準</h2>
          <p className="reviews__principle">{RANK_PROMOTION_PRINCIPLE}</p>
          <div className="reviews__promoGrid">
            {RANK_PROMOTIONS.map((p) => (
              <div key={p.label} className="reviews__promoCard">
                <span className="reviews__promoLabel">{p.label}</span>
                <dl className="reviews__promoConds">
                  <div>
                    <dt>条件① 在籍</dt>
                    <dd>{p.cond1}</dd>
                  </div>
                  <div>
                    <dt>条件② 実証</dt>
                    <dd>{p.cond2}</dd>
                  </div>
                </dl>
                <p className="reviews__promoMeaning">{p.meaning}</p>
              </div>
            ))}
          </div>
          <div className="reviews__ruleList">
            {RANK_PROMOTION_NOTES.map((n) => (
              <div key={n.title} className="reviews__rule">
                <span className="reviews__ruleTitle">{n.title}</span>
                <span className="reviews__ruleBody">{n.body}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
  );
}

/** 1軸ぶんのブロック：進化ストーリー階段＋ランク別セル（P→Mの昇順で表示） */
function AxisBlock({
  badge,
  name,
  sub,
  tags,
  accent,
  story,
  cells,
}: {
  badge: React.ReactNode;
  name: string;
  sub: string;
  tags?: string[];
  accent?: string;
  story: string[];
  cells: Record<RankKey, AxisCell>;
}) {
  // 表示は成長の向き（P→S→E→M）で並べる
  const order: RankKey[] = [...RANK_ORDER].reverse() as RankKey[];
  const [open, setOpen] = useState(false);

  return (
    <div className="reviews__axis" style={accent ? { ["--axis" as string]: accent } : undefined}>
      <button className="reviews__axisHead" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="reviews__axisBadgeWrap">{badge}</span>
        <span className="reviews__axisTitle">
          <span className="reviews__axisName">{name}</span>
          <span className="reviews__axisSub">{sub}</span>
        </span>
        {tags && (
          <span className="reviews__axisTags">
            {tags.map((t) => (
              <span key={t} className="reviews__axisTag">
                {t}
              </span>
            ))}
          </span>
        )}
        <span className="reviews__axisStoryInline">
          {story.map((s, i) => (
            <span key={s} className="reviews__axisStoryStep">
              {s}
              {i < story.length - 1 && <span className="reviews__axisArrow"> → </span>}
            </span>
          ))}
        </span>
        <span className="reviews__calloutChev" aria-hidden>
          {open ? "−" : "+"}
        </span>
      </button>
      {open && (
        <div className="reviews__axisCells">
          {order.map((rk) => {
            const cell = cells[rk];
            const rank = rankOf(rk);
            return (
              <div key={rk} className={`reviews__cell reviews__cell--${rk}`}>
                <div className="reviews__cellRank">
                  <span className="reviews__rankBadge">{rank.grades}</span>
                  <span className="reviews__cellRankName">{rank.name}</span>
                </div>
                <div className="reviews__cellBody">
                  <span className="reviews__cellTitle">{cell.title}</span>
                  <p className="reviews__cellText">{cell.body}</p>
                  <p className="reviews__cellExample">
                    <span className="reviews__cellExampleLabel">基準例</span>
                    {cell.example}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default ReviewsRankPage;
