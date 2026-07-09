import { useEffect, useState } from "react";
import { usePulseDashStore } from "../../store/usePulseDashStore";
import { PulseSubnav } from "./PulseSubnav";
import {
  WEATHER_SCALE,
  periodLabel,
  DIMENSION_LABEL,
  type PulseAggregateRow,
} from "../../lib/pulse";

/**
 * パルスサーベイ 管理ダッシュボード（#/pulse・app シェル内タブ）。
 * pulse_monthly_aggregates（脱識別・n<5 マスク済み）を読んで可視化する。
 * 権限は RLS（pulse_access 保有者 or admin）で担保。チャートは依存無しの
 * CSS/SVG で描画する。
 */
export function PulseDashboardPage() {
  const {
    loaded,
    loading,
    error,
    recomputing,
    cycles,
    selectedPeriod,
    aggregates,
    trend,
    loadDashboard,
    selectPeriod,
    recompute,
  } = usePulseDashStore();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  const total = aggregates.find((a) => a.dimension === "total");
  const byDim = (dim: string) =>
    aggregates
      .filter((a) => a.dimension === dim)
      .sort((x, y) => (y.metrics.avg_overall ?? -1) - (x.metrics.avg_overall ?? -1));

  const onRecompute = async () => {
    const res = await recompute();
    setToast(res.ok ? "集計を更新しました" : res.reason ?? "更新に失敗しました");
  };

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ ダッシュボード</h1>
          <p className="pdash__sub">回答率・平均・分布を脱識別集計で表示（小集団 n&lt;5 はマスク）</p>
        </div>
        <div className="pdash__controls">
          <select
            className="pdash__select"
            value={selectedPeriod ?? ""}
            onChange={(e) => selectPeriod(e.target.value)}
          >
            {cycles.map((c) => (
              <option key={c.id} value={c.period}>
                {periodLabel(c.period)}（{c.status === "sent" ? "受付中" : c.status === "closed" ? "終了" : "予定"}）
              </option>
            ))}
          </select>
          <button className="pdash__btn" onClick={onRecompute} disabled={recomputing || !selectedPeriod}>
            {recomputing ? "集計中…" : "集計を更新"}
          </button>
        </div>
      </header>

      <PulseSubnav active="dashboard" />

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && cycles.length === 0 && (
        <p className="pdash__muted">サーベイのサイクルがまだありません。</p>
      )}

      {loaded && !error && cycles.length > 0 && !total && (
        <div className="pdash__empty">
          <p>この期間の集計はまだ計算されていません。</p>
          <button className="pdash__btn pdash__btn--primary" onClick={onRecompute} disabled={recomputing}>
            {recomputing ? "集計中…" : "集計を実行する"}
          </button>
        </div>
      )}

      {loaded && !error && total && (
        <>
          {/* ── ヘッドライン ── */}
          <section className="pdash__cards">
            <Stat
              label="回答率"
              value={
                total.metrics.response_rate != null
                  ? `${Math.round(total.metrics.response_rate * 100)}%`
                  : "—"
              }
              sub={`${total.metrics.n} / ${total.metrics.target ?? "—"} 名`}
            />
            <Stat
              label="平均総合スコア"
              value={total.metrics.avg_overall != null ? total.metrics.avg_overall.toFixed(2) : "—"}
              sub="5点満点（天気5換算）"
              accent
            />
            <Stat label="回答数" value={`${total.metrics.n}`} sub="件" />
          </section>

          {/* ── 天気分布 ＋ 推移 ── */}
          <div className="pdash__row">
            <section className="pdash__panel">
              <h2 className="pdash__h2">天気分布</h2>
              <WeatherDist dist={total.metrics.weather_dist ?? {}} />
            </section>
            <section className="pdash__panel">
              <h2 className="pdash__h2">平均スコアの推移</h2>
              <Trend data={trend} />
            </section>
          </div>

          {/* ── カテゴリ別平均 ── */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">カテゴリ別平均</h2>
            <CategoryBars byCategory={total.metrics.by_category ?? {}} />
          </section>

          {/* ── Unit別平均（部署 / 雇用形態 / 役職） ── */}
          {(["department", "employment_type", "position_title"] as const).map((dim) => (
            <section key={dim} className="pdash__panel">
              <h2 className="pdash__h2">{DIMENSION_LABEL[dim]}平均</h2>
              <DimensionBars rows={byDim(dim)} />
            </section>
          ))}
        </>
      )}

      {toast && (
        <div className="pdash__toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </main>
  );
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className={"pdash__stat" + (accent ? " is-accent" : "")}>
      <div className="pdash__stat-label">{label}</div>
      <div className="pdash__stat-value">{value}</div>
      {sub && <div className="pdash__stat-sub">{sub}</div>}
    </div>
  );
}

/** 天気5段階の横棒（score 5→1）。 */
function WeatherDist({ dist }: { dist: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(dist));
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total === 0) return <p className="pdash__muted">回答なし</p>;
  return (
    <div className="pdash__wdist">
      {WEATHER_SCALE.map((w) => {
        const c = dist[String(w.score)] ?? 0;
        return (
          <div key={w.score} className="pdash__wrow">
            <span className="pdash__wlabel">
              <span aria-hidden>{w.emoji}</span> {w.label}
            </span>
            <div className="pdash__wbar-track">
              <div
                className={`pdash__wbar pdash__wbar--${w.score}`}
                style={{ width: `${(c / max) * 100}%` }}
              />
            </div>
            <span className="pdash__wcount">{c}</span>
          </div>
        );
      })}
    </div>
  );
}

/** カテゴリ別平均バー（5点満点）。 */
function CategoryBars({ byCategory }: { byCategory: Record<string, { avg: number; n: number }> }) {
  const entries = Object.entries(byCategory);
  if (entries.length === 0) return <p className="pdash__muted">データなし</p>;
  return (
    <div className="pdash__bars">
      {entries.map(([cat, m]) => (
        <div key={cat} className="pdash__bar-row">
          <span className="pdash__bar-label">{cat}</span>
          <div className="pdash__bar-track">
            <div className="pdash__bar" style={{ width: `${(m.avg / 5) * 100}%` }}>
              <span className="pdash__bar-val">{m.avg.toFixed(2)}</span>
            </div>
          </div>
          <span className="pdash__bar-n">n={m.n}</span>
        </div>
      ))}
    </div>
  );
}

/** dimension（部署/雇用形態/役職）別の平均バー。n<5 はマスク表示。 */
function DimensionBars({ rows }: { rows: PulseAggregateRow[] }) {
  if (rows.length === 0) return <p className="pdash__muted">データなし</p>;
  return (
    <div className="pdash__bars">
      {rows.map((r) => (
        <div key={r.id} className="pdash__bar-row">
          <span className="pdash__bar-label" title={r.dimension_key}>
            {r.dimension_key}
          </span>
          {r.metrics.masked ? (
            <div className="pdash__bar-track pdash__bar-track--masked">
              <span className="pdash__masked">n&lt;5 マスク</span>
            </div>
          ) : (
            <div className="pdash__bar-track">
              <div
                className="pdash__bar"
                style={{ width: `${((r.metrics.avg_overall ?? 0) / 5) * 100}%` }}
              >
                <span className="pdash__bar-val">{r.metrics.avg_overall?.toFixed(2)}</span>
              </div>
            </div>
          )}
          <span className="pdash__bar-n">n={r.metrics.n}</span>
        </div>
      ))}
    </div>
  );
}

/** 推移スパークライン（SVG・依存なし）。 */
function Trend({ data }: { data: { period: string; avg: number | null }[] }) {
  const pts = data.filter((d) => d.avg != null) as { period: string; avg: number }[];
  if (pts.length === 0) return <p className="pdash__muted">データなし</p>;
  if (pts.length === 1) {
    return (
      <p className="pdash__muted">
        {periodLabel(pts[0].period)}：<strong>{pts[0].avg.toFixed(2)}</strong>（推移は2期以上で表示）
      </p>
    );
  }
  const W = 480, H = 120, pad = 24;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const ys = (v: number) => H - pad - ((v - 1) / 4) * (H - pad * 2); // 1..5 → 下..上
  const line = pts.map((p, i) => `${xs(i)},${ys(p.avg)}`).join(" ");
  return (
    <svg className="pdash__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[1, 2, 3, 4, 5].map((g) => (
        <line key={g} x1={pad} x2={W - pad} y1={ys(g)} y2={ys(g)} className="pdash__grid" />
      ))}
      <polyline points={line} className="pdash__spark-line" fill="none" />
      {pts.map((p, i) => (
        <g key={p.period}>
          <circle cx={xs(i)} cy={ys(p.avg)} r={4} className="pdash__spark-dot" />
          <text x={xs(i)} y={H - 6} className="pdash__spark-x" textAnchor="middle">
            {p.period.slice(2)}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default PulseDashboardPage;
