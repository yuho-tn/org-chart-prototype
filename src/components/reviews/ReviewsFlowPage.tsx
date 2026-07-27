import { ReviewsSubnav } from "./ReviewsSubnav";
import { FLOW_PHASES, FLOW_SCHEDULE, EVAL_TYPES } from "../../lib/reviewsContent";

/**
 * 評価の流れページ（#/reviews/flow）。
 * Ⅰ〜Ⅴの5フェーズタイムライン（本人／上長の色分け）＋半期の段取り＋
 * ミッションシートの評価種別。
 */
export function ReviewsFlowPage() {
  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="flow" />
        <header className="page__header reviews__header">
          <h1 className="page__title">評価の流れ</h1>
          <p className="page__subtitle">
            半期ごとに、振り返り → 面談 → 評価通知 → 次期目標設計 の順で進みます。
            あなた（本人）の動きはⅠ〜Ⅴの5ステップです。
          </p>
        </header>

        {/* 凡例 */}
        <div className="reviews__legend">
          <span className="reviews__legendItem reviews__legendItem--self">被評価者（本人）の動き</span>
          <span className="reviews__legendItem reviews__legendItem--mgr">
            評価担当者（上長）・評価会議は裏で並走
          </span>
        </div>

        {/* タイムライン */}
        <section className="reviews__section">
          <ol className="reviews__flow">
            {FLOW_PHASES.map((p) => (
              <li
                key={p.num}
                className={`reviews__phase ${p.actor === "本人" ? "reviews__phase--self" : "reviews__phase--both"}`}
              >
                <div className="reviews__phaseNum">{p.num}</div>
                <div className="reviews__phaseBody">
                  <div className="reviews__phaseHead">
                    <h3 className="reviews__phaseTitle">{p.title}</h3>
                    <span className="reviews__phaseActor">{p.actor}</span>
                    {p.format && <span className="reviews__phaseFormat">{p.format}</span>}
                  </div>
                  <p className="reviews__phaseSummary">{p.summary}</p>
                  {p.details.length > 0 && (
                    <ul className="reviews__phaseList">
                      {p.details.map((d) => (
                        <li key={d}>{d}</li>
                      ))}
                    </ul>
                  )}
                  {p.notes && (
                    <div className="reviews__phaseNotes">
                      {p.notes.map((n) => (
                        <p key={n} className="reviews__phaseNote">
                          {n}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p className="reviews__note">
            Ⅱ（振り返り面談）では評価は決定しません＝「評価申請内容の決定」です。その後、部署を跨いだ平準化（評価会議）を経て、Ⅲで最終決定評価が通知されます。
          </p>
        </section>

        {/* 半期の段取り */}
        <section className="reviews__section">
          <h2 className="reviews__h2">半期の段取り（目安）</h2>
          <p className="reviews__lead">
            評価サイクルは期末月の中旬に始まり、翌期1ヶ月目の中旬に完結する約1ヶ月のプロセスです。
            Ⅲ（評価通知）とⅣ・Ⅴ（次期目標設計）は並走します。実際の日程は各期の広報を確認してください。
          </p>
          <div className="reviews__schedule">
            {FLOW_SCHEDULE.map((s) => (
              <div key={s.phase} className="reviews__schedRow">
                <span className="reviews__schedPhase">{s.phase}</span>
                <span className="reviews__schedTiming">{s.timing}</span>
                <span className="reviews__schedSpan">{s.span}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ミッションシートの評価種別 */}
        <section className="reviews__section">
          <h2 className="reviews__h2">ミッションシートで扱う評価</h2>
          <p className="reviews__lead">
            ミッションシートは「スキル・スタンス」「成果」「査定」の3タブ構成で、次の6種の評価を扱います。
          </p>
          <div className="reviews__evalGrid">
            {EVAL_TYPES.map((e) => (
              <div key={e.name} className="reviews__evalCard">
                <h3 className="reviews__evalName">{e.name}</h3>
                <p className="reviews__evalTarget">
                  <span className="reviews__evalLabel">対象</span>
                  {e.target}
                </p>
                <p className="reviews__evalHow">
                  <span className="reviews__evalLabel">方法</span>
                  {e.how}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>
  );
}

export default ReviewsFlowPage;
