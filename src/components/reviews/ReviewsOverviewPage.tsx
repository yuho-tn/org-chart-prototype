import { useUiStore } from "../../store/useUiStore";
import { ReviewsSubnav } from "./ReviewsSubnav";
import {
  RANKS,
  RANK_GAPS,
  GRADES,
  TWO_LAYER,
  VBCF,
  SENSE_INTRO,
  CREDO_AXES,
  SENSE_AXES,
  QUALITY_ASSURANCE,
} from "../../lib/reviewsContent";

/**
 * 人事評価制度 — 制度の全体像（#/reviews）。
 * 2層構造（ランク=質×グレード=量）→ VBCF/6SENSE の思想接続 →
 * 4ランクの言葉 → 16グレードマップ → 制度の信頼性、の順で読ませる。
 */
export function ReviewsOverviewPage() {
  const navigate = useUiStore((s) => s.navigate);

  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="overview" />
        <header className="page__header reviews__header">
          <h1 className="page__title">人事評価制度</h1>
          <p className="page__subtitle">
            SHO-SANの評価制度は「在り方と能力（質）」と「任せられる仕事（量）」の2層で、
            あなたの現在地と次の一歩を言葉にします。
          </p>
        </header>

        {/* 2層構造 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">制度の骨格 — 2層構造</h2>
          <div className="reviews__twolayer">
            <button
              className="reviews__layerCard reviews__layerCard--rank"
              onClick={() => navigate({ name: "reviews_rank" })}
            >
              <span className="reviews__layerAxis">質</span>
              <span className="reviews__layerName">{TWO_LAYER.rank.label}</span>
              <span className="reviews__layerDesc">{TWO_LAYER.rank.desc}</span>
              <span className="reviews__layerDetail">{TWO_LAYER.rank.detail}</span>
              <span className="reviews__layerLink">ランク基準を見る →</span>
            </button>
            <span className="reviews__layerTimes" aria-hidden>
              ×
            </span>
            <button
              className="reviews__layerCard reviews__layerCard--grade"
              onClick={() => navigate({ name: "reviews_grade" })}
            >
              <span className="reviews__layerAxis">量</span>
              <span className="reviews__layerName">{TWO_LAYER.grade.label}</span>
              <span className="reviews__layerDesc">{TWO_LAYER.grade.desc}</span>
              <span className="reviews__layerDetail">{TWO_LAYER.grade.detail}</span>
              <span className="reviews__layerLink">グレード基準を見る →</span>
            </button>
          </div>
          <p className="reviews__note">
            号俸（グレード＝量）とランク（13軸＝質）は別々に判定します。面談でもこの2つは分けて伝えられます。
          </p>
        </section>

        {/* VBCF 思想接続 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">評価の物差しは、VBCFから生まれている</h2>
          <p className="reviews__lead">
            ランクの13軸は独自に発明したものではなく、SHO-SANの
            <strong> CREDO（行動指針・7項目）</strong>と<strong> 6SENSE（スキル・6項目）</strong>
            をそのまま評価の言葉にしたものです。
          </p>
          <div className="reviews__vbcf">
            {[VBCF.vision, VBCF.belief, VBCF.credo, VBCF.focus].map((v) => (
              <div key={v.label} className={`reviews__vbcfItem reviews__vbcfItem--${v.label.toLowerCase()}`}>
                <span className="reviews__vbcfLabel">{v.label}</span>
                <span className="reviews__vbcfSub">{v.sub}</span>
                <span className="reviews__vbcfPhrase">{v.phrase}</span>
              </div>
            ))}
          </div>

          <div className="reviews__pyramid">
            <div className="reviews__pyrTop">VALUE</div>
            <div className="reviews__pyrMid">
              <span className="reviews__pyrMidLabel">6 SENSE / SKILLS</span>
              <span className="reviews__pyrChips">
                {SENSE_AXES.map((s) => (
                  <span
                    key={s.key}
                    className="reviews__senseChip"
                    style={{ ["--chip" as string]: s.color, ["--chipSoft" as string]: s.colorSoft }}
                  >
                    {s.name}
                  </span>
                ))}
              </span>
            </div>
            <div className="reviews__pyrBase">
              <span className="reviews__pyrBaseLabel">CREDO / STANCE</span>
              <span className="reviews__pyrChips">
                {CREDO_AXES.map((c) => (
                  <span key={c.key} className="reviews__credoChip">
                    <span className="reviews__credoNo">{c.credoNo}</span>
                    {c.name}
                  </span>
                ))}
              </span>
            </div>
          </div>
          <p className="reviews__note">{SENSE_INTRO}</p>
        </section>

        {/* 4ランクの言葉 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">4つのランク</h2>
          <div className="reviews__rankGrid">
            {RANKS.map((r) => (
              <div key={r.key} className={`reviews__rankCard reviews__rankCard--${r.key}`}>
                <div className="reviews__rankHead">
                  <span className="reviews__rankBadge">{r.grades}</span>
                  <span className="reviews__rankEn">{r.en}</span>
                </div>
                <h3 className="reviews__rankName">{r.name}</h3>
                <p className="reviews__rankTagline">{r.tagline}</p>
                <p className="reviews__rankOverview">{r.overview}</p>
                <dl className="reviews__rankMeta">
                  <div>
                    <dt>自走</dt>
                    <dd>{r.jiso}</dd>
                  </div>
                  <div>
                    <dt>品質</dt>
                    <dd>{r.quality}</dd>
                  </div>
                  <div>
                    <dt>影響範囲</dt>
                    <dd>{r.impact}</dd>
                  </div>
                  <div>
                    <dt>月給基準</dt>
                    <dd>{r.salary}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <div className="reviews__gaps">
            {RANK_GAPS.map((g) => (
              <div key={g.label} className="reviews__gap">
                <span className="reviews__gapLabel">{g.label}</span>
                <span className="reviews__gapPhrase">{g.phrase}</span>
                <span className="reviews__gapDesc">{g.desc}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 16グレードマップ */}
        <section className="reviews__section">
          <h2 className="reviews__h2">キャリアの全体マップ — 16グレード</h2>
          <p className="reviews__lead">
            下から上へ。各ランクの中は「1＝入口 → 5＝完成（次ランクへの挑戦権）」の5段階です。
          </p>
          <div className="reviews__ladder">
            {GRADES.map((g) => (
              <button
                key={g.code}
                className={`reviews__rung reviews__rung--${g.rank}`}
                onClick={() => navigate({ name: "reviews_grade" })}
                title={`${g.code}：${g.title}`}
              >
                <span className="reviews__rungCode">{g.code}</span>
                <span className="reviews__rungTitle">{g.title}</span>
                <span className="reviews__rungSalary">{g.salary}</span>
              </button>
            ))}
          </div>
        </section>

        {/* 制度の信頼性 */}
        <section className="reviews__section reviews__section--quality">
          <h2 className="reviews__h2">この基準書の品質保証</h2>
          <p className="reviews__lead">
            本基準（v2.2／2026年7月確定）は、公開前に次のプロセスで検証されています。
          </p>
          <div className="reviews__quality">
            {QUALITY_ASSURANCE.map((q) => (
              <div key={q.step} className="reviews__qualityItem">
                <span className="reviews__qualityStep">{q.step}</span>
                <span className="reviews__qualityBody">{q.body}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
  );
}

export default ReviewsOverviewPage;
