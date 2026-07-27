import { useState, Fragment } from "react";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowUpRight,
  X,
} from "lucide-react";
import { useUiStore } from "../../store/useUiStore";
import { ReviewsSubnav } from "./ReviewsSubnav";
import {
  RANKS,
  GRADES,
  GRADE_ENGINE,
  TWO_LAYER,
  VBCF,
  SENSE_INTRO,
  CREDO_AXES,
  SENSE_AXES,
  JUDGE_RULES,
  QUALITY_ASSURANCE,
  rankOf,
  type RankKey,
  type AxisCell,
} from "../../lib/reviewsContent";

/**
 * 人事評価制度 — 制度ハブ（#/reviews）。
 * 質×量の2枚看板で「自分の現在地と次の一歩」を言葉にする俯瞰ページ。
 *   1. ヘッダ
 *   2. 制度の骨格＝2層（イントロ）
 *   3. 量の地図＝16グレードはしご（常時全表示・行クリックでドック展開）
 *   4. 質の地図＝13軸×4ランク マトリクス（sticky・セルクリックで下部ドック展開／モバイルは軸カード）
 *   5. （従属）VBCF思想接続・4ランクの言葉・品質保証
 *
 * 状態は「開いているドックの対象セル/行」のローカルstateのみ。localStorage・現在地入力なし。
 * データは reviewsContent.ts の既存定数からのみ算出（同ファイルは無改変）。
 */

/** マトリクスは 質＝弱(P)→強(M) の順で読ませる。RANK_ORDER は M始まりのため専用に定義。 */
const MX_COLS: RankKey[] = ["P", "S", "E", "M"];
/** 成長ヒートマップの濃度（淡→濃）。色は軸ベース色に対する mix 率。 */
const MX_PCT: Record<RankKey, string> = { P: "10%", S: "22%", E: "40%", M: "62%" };

type MxAxis = {
  key: string;
  kind: "credo" | "sense";
  name: string;
  /** CREDO=番号／6SENSE=英名 */
  badge: string;
  /** CREDO=原典フレーズ／6SENSE=キャッチ */
  phrase: string;
  color?: string;
  colorSoft?: string;
  tags?: string[];
  story: string[];
  cells: Record<RankKey, AxisCell>;
};

const CREDO_MX: MxAxis[] = CREDO_AXES.map((a) => ({
  key: a.key,
  kind: "credo",
  name: a.name,
  badge: a.credoNo,
  phrase: a.credoPhrase,
  story: a.story,
  cells: a.cells,
}));

const SENSE_MX: MxAxis[] = SENSE_AXES.map((a) => ({
  key: a.key,
  kind: "sense",
  name: a.name,
  badge: a.en,
  phrase: a.catch,
  color: a.color,
  colorSoft: a.colorSoft,
  tags: a.tags,
  story: a.story,
  cells: a.cells,
}));

const MX_AXES: MxAxis[] = [...CREDO_MX, ...SENSE_MX];

export function ReviewsOverviewPage() {
  const navigate = useUiStore((s) => s.navigate);

  return (
    <main className="page reviews__page">
      <ReviewsSubnav active="overview" />
      <header className="page__header reviews__header">
        <h1 className="page__title">人事評価制度</h1>
        <p className="page__subtitle">
          質（在り方と能力）× 量（任せられる仕事）の2層で、あなたの現在地と次の一歩を言葉にします。
          誰でも読んで自分の行を見つけられるよう、2枚の地図で制度の全体を一望できます。
        </p>
      </header>

      {/* 2. 制度の骨格 ＝ 2層（イントロ） */}
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
          この2つは<strong>別々に判定し、別々に伝えます</strong>。号俸（グレード＝量）とランク（13軸＝質）は面談でも必ず分けて共有されます。
        </p>
      </section>

      {/* 3. 量の地図 ＝ 16グレードはしご */}
      <QuantityLadder />

      {/* 4. 質の地図 ＝ 13軸×4ランク マトリクス */}
      <QualityMatrix />

      {/* 5. （従属）VBCF思想接続 */}
      <VbcfSection />

      {/* 5. （従属）4つのランクの言葉 */}
      <section className="reviews__section">
        <h2 className="reviews__h2">4つのランクの言葉</h2>
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
      </section>

      {/* 5. （従属）品質保証 */}
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

/* ────────────────────────────────────────────────────────────
   量の地図 ＝ 16グレードはしご
──────────────────────────────────────────────────────────── */
function QuantityLadder() {
  const [openCode, setOpenCode] = useState<string | null>(null);

  return (
    <section className="reviews__section">
      <h2 className="reviews__h2">量の地図 — 16グレードのはしご</h2>
      <p className="reviews__lead">
        下（P1）から上（M）へ。各行は「いま任せられている仕事の大きさ」。行をクリックすると、その説明と“次の一歩（昇格基準）”が開きます。
      </p>

      {/* 進化エンジン凡例 */}
      <div className="reviews__engine reviews__engine--legend">
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

      <div className="reviews__ladderFull">
        {GRADES.map((g, i) => {
          // GRADES は M（index0）… P1（index末尾）の順。"1つ上"＝前のインデックス。
          const nextUp = i > 0 ? GRADES[i - 1] : null;
          const isBoundary = !!nextUp && nextUp.rank !== g.rank;
          const rank = rankOf(g.rank as RankKey);
          const open = openCode === g.code;
          return (
            <div key={g.code} className={`reviews__lrow reviews__lrow--${g.rank}`}>
              <button
                className="reviews__lrowHead"
                onClick={() => setOpenCode(open ? null : g.code)}
                aria-expanded={open}
              >
                <span className={`reviews__lcode reviews__lcode--${g.rank}`}>{g.code}</span>
                <span className="reviews__lrank">{rank.name}</span>
                <span className="reviews__ltitle">{g.title}</span>
                <span className="reviews__lsalary">{g.salary}</span>
                {nextUp ? (
                  <span
                    className={
                      "reviews__lnext" + (isBoundary ? " reviews__lnext--rank" : "")
                    }
                  >
                    {isBoundary ? <ArrowUpRight size={12} /> : <ArrowUp size={12} />}
                    <span className="reviews__lnextCode">
                      次の一歩 {nextUp.code}
                    </span>
                    {isBoundary && <em className="reviews__lnextTag">ランク昇格</em>}
                  </span>
                ) : (
                  <span className="reviews__lnext reviews__lnext--top">到達点</span>
                )}
                <ChevronDown
                  size={16}
                  className={"reviews__lchev" + (open ? " is-open" : "")}
                  aria-hidden
                />
              </button>
              <div className="reviews__lbody" hidden={!open}>
                <p className="reviews__lbodyText">{g.body}</p>
                <p className="reviews__lpromo">
                  <span className="reviews__lpromoLabel">
                    {isBoundary ? "次の一歩（ランク昇格）" : "次の一歩（昇格基準）"}
                  </span>
                  {g.promotion}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────
   質の地図 ＝ 13軸×4ランク マトリクス（デスクトップ）＋軸カード（モバイル）
──────────────────────────────────────────────────────────── */
type Dock = { key: string; rank: RankKey } | null;

function QualityMatrix() {
  const [openJudge, setOpenJudge] = useState(false);
  const [dock, setDock] = useState<Dock>(null);

  return (
    <section className="reviews__section">
      <h2 className="reviews__h2">質の地図 — 13軸 × 4ランク</h2>
      <p className="reviews__lead">
        在り方（CREDO7軸）と能力（6SENSE6軸）の計13軸。各行を左から右（P→M）へ読むと、その軸の成長のかたちが分かります。セルをクリックすると、下に本文・基準例・進化ストーリーが開きます。
      </p>

      {/* 判定ルール callout（初期閉じ） */}
      <div className="reviews__callout">
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
      </div>

      {/* デスクトップ：マトリクス */}
      <div className="reviews__matrixWrap">
        <div className="reviews__matrix">
          {/* ヘッダ行 */}
          <div className="reviews__mxCorner">
            <span className="reviews__mxCornerAxis">軸</span>
            <span className="reviews__mxCornerRank">ランク →</span>
          </div>
          {MX_COLS.map((rk) => {
            const r = rankOf(rk);
            return (
              <div key={rk} className="reviews__mxColHead">
                <span className={`reviews__mxColBadge reviews__mxColBadge--${rk}`}>
                  {r.grades}
                </span>
                <span className="reviews__mxColRank">{r.name}</span>
                <span className="reviews__mxColSalary">{r.salary}</span>
              </div>
            );
          })}

          {/* CREDO 帯 + 7軸 */}
          <div className="reviews__mxBand reviews__mxBand--credo">
            <span className="reviews__mxBandNo">CREDO</span>
            在り方・7軸
          </div>
          {CREDO_MX.map((axis) => (
            <MatrixRow key={axis.key} axis={axis} dock={dock} setDock={setDock} />
          ))}

          {/* 6SENSE 帯 + 6軸 */}
          <div className="reviews__mxBand reviews__mxBand--sense">
            <span className="reviews__mxBandNo">6SENSE</span>
            能力・6軸
          </div>
          {SENSE_MX.map((axis) => (
            <MatrixRow key={axis.key} axis={axis} dock={dock} setDock={setDock} />
          ))}
        </div>

        {/* ドック（表の下に展開・表を隠さない） */}
        <MatrixDock dock={dock} setDock={setDock} />
      </div>

      {/* モバイル：軸カード縦積み */}
      <div className="reviews__axisCards">
        <div className="reviews__axisCardsBand">
          <span className="reviews__mxBandNo">CREDO</span>在り方・7軸
        </div>
        {CREDO_MX.map((axis) => (
          <AxisCard key={axis.key} axis={axis} />
        ))}
        <div className="reviews__axisCardsBand reviews__axisCardsBand--sense">
          <span className="reviews__mxBandNo">6SENSE</span>能力・6軸
        </div>
        {SENSE_MX.map((axis) => (
          <AxisCard key={axis.key} axis={axis} />
        ))}
      </div>
    </section>
  );
}

function MatrixRow({
  axis,
  dock,
  setDock,
}: {
  axis: MxAxis;
  dock: Dock;
  setDock: (d: Dock) => void;
}) {
  const isSense = axis.kind === "sense";
  return (
    <Fragment>
      <div
        className={"reviews__mxAxisName" + (isSense ? " reviews__mxAxisName--sense" : "")}
        style={isSense ? ({ ["--axis" as string]: axis.color } as React.CSSProperties) : undefined}
      >
        <span
          className={
            isSense ? "reviews__mxAxisBadge reviews__mxAxisBadge--sense" : "reviews__mxAxisBadge"
          }
        >
          {isSense ? axis.badge : `#${axis.badge}`}
        </span>
        <span className="reviews__mxAxisLabel">{axis.name}</span>
      </div>
      {MX_COLS.map((rk) => {
        const cell = axis.cells[rk];
        const active = !!dock && dock.key === axis.key && dock.rank === rk;
        const base = isSense ? axis.color! : "var(--navy-700)";
        return (
          <button
            key={rk}
            className={"reviews__mxCell" + (active ? " is-active" : "")}
            style={
              {
                ["--mxBase" as string]: base,
                ["--mxPct" as string]: MX_PCT[rk],
              } as React.CSSProperties
            }
            onClick={() => setDock(active ? null : { key: axis.key, rank: rk })}
            title={`${axis.name} × ${rankOf(rk).name}`}
          >
            <span className="reviews__mxCellTitle">{cell.title}</span>
          </button>
        );
      })}
    </Fragment>
  );
}

function MatrixDock({ dock, setDock }: { dock: Dock; setDock: (d: Dock) => void }) {
  if (!dock) return null;
  const axis = MX_AXES.find((a) => a.key === dock.key);
  if (!axis) return null;
  const idx = MX_COLS.indexOf(dock.rank);
  const rank = rankOf(dock.rank);
  const cell = axis.cells[dock.rank];
  const isSense = axis.kind === "sense";
  const prev = idx > 0 ? MX_COLS[idx - 1] : null;
  const next = idx < MX_COLS.length - 1 ? MX_COLS[idx + 1] : null;

  return (
    <div
      className={"reviews__dock" + (isSense ? " reviews__dock--sense" : "")}
      style={isSense ? ({ ["--axis" as string]: axis.color } as React.CSSProperties) : undefined}
    >
      <div className="reviews__dockHead">
        <button
          className="reviews__dockNav"
          onClick={() => prev && setDock({ key: axis.key, rank: prev })}
          disabled={!prev}
          aria-label="1つ下のランクへ"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="reviews__dockTitleWrap">
          <span
            className={
              isSense ? "reviews__mxAxisBadge reviews__mxAxisBadge--sense" : "reviews__mxAxisBadge"
            }
          >
            {isSense ? axis.badge : `#${axis.badge}`}
          </span>
          <span className="reviews__dockAxis">{axis.name}</span>
          <span className="reviews__dockTimes" aria-hidden>
            ×
          </span>
          <span className="reviews__dockRank">
            {rank.name}
            <em className="reviews__dockRankGrades">{rank.grades}</em>
          </span>
          <span className="reviews__dockSalary">{rank.salary}</span>
        </div>
        <button
          className="reviews__dockNav"
          onClick={() => next && setDock({ key: axis.key, rank: next })}
          disabled={!next}
          aria-label="1つ上のランクへ"
        >
          <ChevronRight size={16} />
        </button>
        <button
          className="reviews__dockClose"
          onClick={() => setDock(null)}
          aria-label="閉じる"
        >
          <X size={16} />
        </button>
      </div>

      <div className="reviews__dockBody">
        <p className="reviews__dockCellTitle">{cell.title}</p>
        <p className="reviews__dockCellText">{cell.body}</p>
        <p className="reviews__dockExample">
          <span className="reviews__dockExampleLabel">基準例</span>
          {cell.example}
        </p>
        <div className="reviews__dockStory" role="list">
          {axis.story.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && (
                <span className="reviews__dockStoryArrow" aria-hidden>
                  →
                </span>
              )}
              <span
                className={
                  "reviews__dockStoryStep" + (i === idx ? " is-current" : "")
                }
                role="listitem"
              >
                {s}
              </span>
            </Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}

/** モバイル用：1軸カード（storyステッパー常時＋タップで4ランク展開） */
function AxisCard({ axis }: { axis: MxAxis }) {
  const [open, setOpen] = useState(false);
  const isSense = axis.kind === "sense";
  return (
    <div
      className={"reviews__axisCard" + (isSense ? " reviews__axisCard--sense" : "")}
      style={isSense ? ({ ["--axis" as string]: axis.color } as React.CSSProperties) : undefined}
    >
      <button
        className="reviews__axisCardHead"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="reviews__axisCardTop">
          <span
            className={
              isSense ? "reviews__mxAxisBadge reviews__mxAxisBadge--sense" : "reviews__mxAxisBadge"
            }
          >
            {isSense ? axis.badge : `#${axis.badge}`}
          </span>
          <span className="reviews__axisCardName">{axis.name}</span>
          <ChevronDown
            size={16}
            className={"reviews__lchev" + (open ? " is-open" : "")}
            aria-hidden
          />
        </span>
        <span className="reviews__axisCardStory">
          {axis.story.map((s, i) => (
            <Fragment key={s}>
              {i > 0 && (
                <span className="reviews__axisCardArrow" aria-hidden>
                  →
                </span>
              )}
              <span className="reviews__axisCardStep">{s}</span>
            </Fragment>
          ))}
        </span>
      </button>
      {open && (
        <div className="reviews__axisCardBody">
          {MX_COLS.map((rk) => {
            const cell = axis.cells[rk];
            const rank = rankOf(rk);
            return (
              <div key={rk} className={`reviews__axisCardRank reviews__axisCardRank--${rk}`}>
                <div className="reviews__axisCardRankHead">
                  <span className="reviews__rankBadge">{rank.grades}</span>
                  <span className="reviews__axisCardRankName">{rank.name}</span>
                </div>
                <span className="reviews__axisCardRankTitle">{cell.title}</span>
                <p className="reviews__axisCardRankText">{cell.body}</p>
                <p className="reviews__axisCardRankEx">
                  <span className="reviews__dockExampleLabel">基準例</span>
                  {cell.example}
                </p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** VBCF 思想接続（従属・折り畳み） */
function VbcfSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="reviews__section">
      <div className="reviews__foldHead">
        <h2 className="reviews__h2 reviews__h2--fold">評価の物差しは、VBCF から生まれている</h2>
        <button
          className="reviews__foldToggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? "閉じる −" : "ひらく ＋"}
        </button>
      </div>
      {open && (
        <div className="reviews__foldBody">
          <p className="reviews__lead">
            ランクの13軸は独自に発明したものではなく、SHO-SANの
            <strong> CREDO（行動指針・7項目）</strong>と
            <strong> 6SENSE（スキル・6項目）</strong>
            をそのまま評価の言葉にしたものです。
          </p>
          <div className="reviews__vbcf">
            {[VBCF.vision, VBCF.belief, VBCF.credo, VBCF.focus].map((v) => (
              <div
                key={v.label}
                className={`reviews__vbcfItem reviews__vbcfItem--${v.label.toLowerCase()}`}
              >
                <span className="reviews__vbcfLabel">{v.label}</span>
                <span className="reviews__vbcfSub">{v.sub}</span>
                <span className="reviews__vbcfPhrase">{v.phrase}</span>
              </div>
            ))}
          </div>
          <p className="reviews__note">{SENSE_INTRO}</p>
        </div>
      )}
    </section>
  );
}

export default ReviewsOverviewPage;
