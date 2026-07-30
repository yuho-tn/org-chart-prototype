import { useEffect, useMemo, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Check,
  Lock,
  Minus,
  Settings,
} from "lucide-react";
import "./pulse-shared.css";
import { usePulseDashStore } from "../../store/usePulseDashStore";
import { useUiStore } from "../../store/useUiStore";
import { useRevalidateOnFocus } from "../../lib/useRevalidateOnFocus";
import { PulseSubnav } from "./PulseSubnav";
import { PulseToast, usePulseToast } from "./usePulseToast";
import {
  WEATHER_SCALE,
  periodLabel,
  CYCLE_STATUS_LABEL,
  DIMENSION_LABEL,
  type PulseAggregateRow,
  type PulseCycleRow,
} from "../../lib/pulse";
import { buildCsv, downloadCsv } from "../../lib/pulseCsv";

/**
 * パルスサーベイ 管理ダッシュボード（#/pulse・パルス領域のトップ）。
 * pulse_monthly_aggregates（脱識別・n<5 マスク済み）を読んで可視化する。
 * 権限は RLS（pulse_access 保有者 or admin）で担保。チャートは依存無しの
 * CSS/SVG で描画する。
 *
 * v2（設計書 §5）:
 *   • ヒーローバー … 選択サイクルの状態＋回答率＋締切＋「リマインド送信」「受付を終了」。
 *   • オンボーディング空状態 … サイクル未作成/全終了のとき4ステップで次の一手を示す。
 *   • 自動集計 … store 側で compute → silent 再取得（権限なしは無視）。
 *   • 指標カード4枚（前回比の矢印つき）＋各チャートは useMemo で算出。
 */
export function PulseDashboardPage() {
  const {
    loaded,
    loading,
    error,
    recomputing,
    autoComputing,
    summarizing,
    notifying,
    closing,
    cycles,
    selectedPeriod,
    aggregates,
    trend,
    summary,
    summaryError,
    cycleStats,
    openAlerts,
    activeSetCount,
    lastNotify,
    loadDashboard,
    selectPeriod,
    recompute,
    generateSummary,
    remindCycle,
    closeSelectedCycle,
  } = usePulseDashStore();
  const navigate = useUiStore((s) => s.navigate);
  const { toast, showToast, clearToast } = usePulseToast();

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  // タブ復帰時に silent 再取得（受付中サイクルの回答数を最新化する）。
  useRevalidateOnFocus(() => {
    void loadDashboard({ silent: true });
  });

  const cycle = useMemo(
    () => cycles.find((c) => c.period === selectedPeriod) ?? null,
    [cycles, selectedPeriod],
  );
  const stat = cycle ? (cycleStats[cycle.id] ?? null) : null;
  const total = useMemo(() => aggregates.find((a) => a.dimension === "total") ?? null, [aggregates]);

  /** 前回（集計がある1つ前の期）の total 値。前回比の矢印に使う。 */
  const prevPoint = useMemo(() => {
    if (!selectedPeriod) return null;
    const i = trend.findIndex((t) => t.period === selectedPeriod);
    if (i <= 0) return null;
    return trend[i - 1];
  }, [trend, selectedPeriod]);

  const avgSeries = useMemo(
    () => trend.filter((t) => t.avg != null).map((t) => ({ period: t.period, value: t.avg as number })),
    [trend],
  );
  const enpsSeries = useMemo(
    () => trend.filter((t) => t.enps != null).map((t) => ({ period: t.period, value: t.enps as number })),
    [trend],
  );
  const rateSeries = useMemo(
    () => trend.filter((t) => t.rate != null).map((t) => ({ period: t.period, value: t.rate as number })),
    [trend],
  );

  const categories = useMemo(() => {
    const src = total?.metrics.by_category ?? {};
    return Object.entries(src).sort((a, b) => b[1].avg - a[1].avg);
  }, [total]);

  const dimRows = useMemo(() => {
    const out: Record<string, PulseAggregateRow[]> = {};
    for (const dim of ["department", "employment_type", "position_title"] as const) {
      out[dim] = aggregates
        .filter((a) => a.dimension === dim)
        .sort((x, y) => (y.metrics.avg_overall ?? -1) - (x.metrics.avg_overall ?? -1));
    }
    return out;
  }, [aggregates]);

  /** オンボーディング（行き止まり禁止）を出すか＝進行中サイクルが1つも無い。 */
  const openCycle = useMemo(() => cycles.find((c) => c.status !== "closed") ?? null, [cycles]);
  const showOnboarding = loaded && !error && !openCycle;

  const onRecompute = async () => {
    const res = await recompute();
    showToast(res.ok ? "success" : "error", res.ok ? "集計を更新しました" : (res.reason ?? "更新に失敗しました"));
  };

  const onSummarize = async () => {
    showToast("info", "AI要約を生成中…（10〜20秒）");
    const res = await generateSummary();
    showToast(res.ok ? "success" : "error", res.ok ? "AI要約を生成しました" : (res.reason ?? "要約に失敗しました"));
  };

  const onRemind = async () => {
    const res = await remindCycle();
    showToast(res.ok ? "success" : "error", res.reason ?? (res.ok ? "送信しました" : "送信に失敗しました"));
  };

  const onClose = async () => {
    if (!cycle) return;
    const ok = window.confirm(
      `${periodLabel(cycle.period)} の受付を終了します。以降は回答できなくなります。よろしいですか？`,
    );
    if (!ok) return;
    const res = await closeSelectedCycle();
    showToast(res.ok ? "success" : "error", res.reason ?? (res.ok ? "受付を終了しました" : "終了に失敗しました"));
  };

  const onCsv = () => {
    // 表示中と同じマスク通過データのみ（n<5 は値なしのまま出力）
    const csv = buildCsv(
      ["区分", "キー", "回答数", "マスク", "平均総合", "eNPS回答数", "eNPS", "推奨者%", "批判者%"],
      [...aggregates]
        .sort((a, b) =>
          a.dimension === b.dimension
            ? a.dimension_key.localeCompare(b.dimension_key, "ja")
            : a.dimension.localeCompare(b.dimension),
        )
        .map((r) => [
          DIMENSION_LABEL[r.dimension] ?? r.dimension,
          r.dimension_key || "全体",
          r.metrics.n,
          r.metrics.masked ? "n<5" : "",
          r.metrics.masked ? "" : (r.metrics.avg_overall ?? ""),
          r.metrics.enps_n ?? "",
          r.metrics.enps_masked ? "" : (r.metrics.enps ?? ""),
          r.metrics.enps_masked ? "" : (r.metrics.promoter_rate ?? ""),
          r.metrics.enps_masked ? "" : (r.metrics.detractor_rate ?? ""),
        ]),
    );
    downloadCsv(`pulse_dashboard_${selectedPeriod ?? "all"}.csv`, csv);
  };

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ ダッシュボード</h1>
          <p className="pdash__sub">回答率・平均・分布を脱識別集計で表示（小集団 n&lt;5 はマスク）</p>
        </div>
        <div className="pdash__controls">
          {autoComputing && <span className="pdash__auto">自動集計中…</span>}
          <select
            className="pdash__select"
            aria-label="対象期間"
            value={selectedPeriod ?? ""}
            onChange={(e) => selectPeriod(e.target.value)}
            disabled={cycles.length === 0}
          >
            {cycles.length === 0 && <option value="">対象期間なし</option>}
            {cycles.map((c) => (
              <option key={c.id} value={c.period}>
                {periodLabel(c.period)}（{CYCLE_STATUS_LABEL[c.status] ?? c.status}）
              </option>
            ))}
          </select>
          <button className="pdash__btn" onClick={onRecompute} disabled={recomputing || !selectedPeriod}>
            {recomputing ? "集計中…" : "集計を更新"}
          </button>
          <button className="pdash__btn" disabled={aggregates.length === 0} onClick={onCsv}>
            CSVダウンロード
          </button>
        </div>
      </header>

      <PulseSubnav active="dashboard" />

      {!loaded && loading && <DashSkeleton />}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {showOnboarding && (
        <Onboarding
          cycles={cycles}
          activeSetCount={activeSetCount}
          onOpenAdmin={() => navigate({ name: "pulse_admin" })}
        />
      )}

      {loaded && !error && cycle && (
        <HeroBar
          cycle={cycle}
          responses={stat?.responses ?? null}
          target={stat?.target ?? total?.metrics.target ?? null}
          fallbackRate={total?.metrics.response_rate ?? null}
          hasAggregates={!!total}
          notifying={notifying}
          closing={closing}
          lastNotify={lastNotify}
          onRemind={onRemind}
          onClose={onClose}
        />
      )}

      {loaded && !error && cycles.length > 0 && !total && !loading && (
        <div className="pdash__empty">
          <p>この期間の集計はまだ計算されていません。</p>
          <button className="pdash__btn pdash__btn--primary" onClick={onRecompute} disabled={recomputing}>
            {recomputing ? "集計中…" : "集計を実行する"}
          </button>
        </div>
      )}

      {loaded && !error && total && (
        <>
          {/* ── 指標カード4枚（前回比つき） ── */}
          <section className="pdash__cards">
            <Stat
              label="回答率"
              value={
                stat && stat.target > 0
                  ? `${Math.round((stat.responses / stat.target) * 100)}%`
                  : total.metrics.response_rate != null
                    ? `${Math.round(total.metrics.response_rate * 100)}%`
                    : "—"
              }
              sub={
                stat
                  ? `${stat.responses} / ${stat.target} 名`
                  : `${total.metrics.n} / ${total.metrics.target ?? "—"} 名`
              }
              delta={deltaOf(total.metrics.response_rate ?? null, prevPoint?.rate ?? null, 0.01)}
              deltaText={fmtDelta(total.metrics.response_rate ?? null, prevPoint?.rate ?? null, (v) =>
                `${Math.round(v * 100)}pt`,
              )}
            />
            <Stat
              label="平均総合スコア"
              value={total.metrics.avg_overall != null ? total.metrics.avg_overall.toFixed(2) : "—"}
              sub="5点満点（天気5換算）"
              accent
              delta={deltaOf(total.metrics.avg_overall ?? null, prevPoint?.avg ?? null, 0.05)}
              deltaText={fmtDelta(total.metrics.avg_overall ?? null, prevPoint?.avg ?? null, (v) => v.toFixed(2))}
            />
            <Stat
              label="eNPS"
              value={
                total.metrics.enps_masked
                  ? "n<5"
                  : total.metrics.enps != null
                    ? `${total.metrics.enps > 0 ? "+" : ""}${total.metrics.enps}`
                    : "—"
              }
              sub={
                total.metrics.enps_masked
                  ? "マスク中（回答が5件未満）"
                  : total.metrics.enps_n
                    ? `推奨${total.metrics.promoter_rate ?? "—"}% − 批判${total.metrics.detractor_rate ?? "—"}%（n=${total.metrics.enps_n}）`
                    : "eNPS設問への回答なし"
              }
              delta={
                total.metrics.enps_masked ? "none" : deltaOf(total.metrics.enps ?? null, prevPoint?.enps ?? null, 1)
              }
              deltaText={fmtDelta(total.metrics.enps ?? null, prevPoint?.enps ?? null, (v) => String(Math.round(v)))}
            />
            <Stat
              label="未対応アラート"
              value={openAlerts != null ? String(openAlerts) : "—"}
              sub={openAlerts != null ? "クリックで一覧へ" : "閲覧権限がありません"}
              icon={<Bell size={14} aria-hidden />}
              warn={openAlerts != null && openAlerts > 0}
              onClick={openAlerts != null ? () => navigate({ name: "pulse_alerts" }) : undefined}
            />
          </section>

          {/* ── AI要約（Claude・Edge Function） ── */}
          <section className="pdash__panel pdash__summary">
            <div className="pdash__summary-head">
              <h2 className="pdash__h2">AI要約</h2>
              <button className="pdash__btn" onClick={onSummarize} disabled={summarizing}>
                {summarizing ? "生成中…" : summary ? "再生成" : "AI要約を生成"}
              </button>
            </div>
            {summaryError && <p className="pdash__error pdash__summary-error">{summaryError}</p>}
            {summary ? (
              <>
                <div className="pdash__summary-body">{summary.summary}</div>
                <p className="pdash__summary-meta">
                  {summary.model ?? "Claude"}
                  {summary.meta?.comment_count != null && `・コメント ${summary.meta.comment_count} 件`}
                  {summary.created_at &&
                    `・${new Date(summary.created_at).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })} 生成`}
                </p>
              </>
            ) : (
              !summaryError && (
                <p className="pdash__muted">
                  未生成です。「AI要約を生成」で集計とコメントから傾向・懸念・推奨アクションを要約します。
                </p>
              )
            )}
          </section>

          {/* ── 天気分布 ＋ 平均スコア推移 ── */}
          <div className="pdash__row">
            <section className="pdash__panel">
              <h2 className="pdash__h2">天気分布</h2>
              <WeatherDist dist={total.metrics.weather_dist ?? {}} />
            </section>
            <section className="pdash__panel">
              <h2 className="pdash__h2">平均スコアの推移</h2>
              <Sparkline
                data={avgSeries}
                min={1}
                max={5}
                guides={[1, 2, 3, 4, 5]}
                format={(v) => v.toFixed(2)}
                formatAxis={(v) => v.toFixed(0)}
                ariaLabel="平均総合スコアの推移"
              />
            </section>
          </div>

          {/* ── eNPS推移（nps 回答がある期のみ） ＋ 回答率推移 ── */}
          <div className="pdash__row">
            {enpsSeries.length > 0 && (
              <section className="pdash__panel">
                <h2 className="pdash__h2">eNPSの推移</h2>
                <Sparkline
                  data={enpsSeries}
                  min={-100}
                  max={100}
                  guides={[-100, -50, 0, 50, 100]}
                  zeroGuide
                  format={(v) => `${v > 0 ? "+" : ""}${Math.round(v)}`}
                  formatAxis={(v) => String(v)}
                  ariaLabel="eNPSの推移"
                />
              </section>
            )}
            {rateSeries.length > 0 && (
              <section className="pdash__panel">
                <h2 className="pdash__h2">回答率の推移</h2>
                <Sparkline
                  data={rateSeries}
                  min={0}
                  max={1}
                  guides={[0, 0.25, 0.5, 0.75, 1]}
                  format={(v) => `${Math.round(v * 100)}%`}
                  formatAxis={(v) => `${Math.round(v * 100)}%`}
                  ariaLabel="回答率の推移"
                />
              </section>
            )}
          </div>

          {/* ── カテゴリ別平均 ── */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">カテゴリ別平均</h2>
            <CategoryBars entries={categories} />
          </section>

          {/* ── Unit別平均（部署 / 雇用形態 / 役職） ── */}
          {(["department", "employment_type", "position_title"] as const).map((dim) => (
            <section key={dim} className="pdash__panel">
              <h2 className="pdash__h2">{DIMENSION_LABEL[dim]}平均</h2>
              <DimensionBars rows={dimRows[dim] ?? []} />
            </section>
          ))}
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
    </main>
  );
}

// ── ヒーローバー ─────────────────────────────────────────────────────

/** 締切表示（"締切 8/25（あと3日）"）。due_date が無ければ null。 */
function dueMeta(due: string | null): { text: string; tone: "normal" | "warn" | "over" } | null {
  const m = due ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(due) : null;
  if (!m) return null;
  const dueDate = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const today = new Date();
  const days = Math.round(
    (dueDate.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000,
  );
  const base = `締切 ${Number(m[2])}/${Number(m[3])}`;
  if (days < 0) return { text: `${base}（${-days}日超過）`, tone: "over" };
  if (days === 0) return { text: `${base}（本日締切）`, tone: "warn" };
  return { text: `${base}（あと${days}日）`, tone: days <= 2 ? "warn" : "normal" };
}

function HeroBar({
  cycle,
  responses,
  target,
  fallbackRate,
  hasAggregates,
  notifying,
  closing,
  lastNotify,
  onRemind,
  onClose,
}: {
  cycle: PulseCycleRow;
  responses: number | null;
  target: number | null;
  fallbackRate: number | null;
  hasAggregates: boolean;
  notifying: boolean;
  closing: boolean;
  lastNotify: { targets: number; slack_ok: number; slack_fail: number; email_ok: number; email_fail: number } | null;
  onRemind: () => void;
  onClose: () => void;
}) {
  const rate =
    responses != null && target != null && target > 0 ? responses / target : (fallbackRate ?? null);
  const pct = rate != null ? Math.round(rate * 100) : null;
  const due = dueMeta(cycle.due_date);

  return (
    <section className={`pdash__hero is-${cycle.status}`} aria-label="サイクルの状態">
      <div className="pdash__hero-main">
        <div className="pdash__hero-line">
          <span className="pdash__hero-period">{periodLabel(cycle.period)}</span>
          <span className={`pdash__chip pdash__chip--${cycle.status}`}>
            {CYCLE_STATUS_LABEL[cycle.status] ?? cycle.status}
          </span>
          {responses != null && target != null ? (
            <span className="pdash__hero-metric">
              回答 <strong>{responses}</strong> / {target}
              {pct != null && `（${pct}%）`}
            </span>
          ) : (
            <span className="pdash__hero-metric pdash__muted">回答数の取得には管理権限が必要です</span>
          )}
          {due && <span className={`pdash__hero-due is-${due.tone}`}>{due.text}</span>}
          {cycle.status === "closed" && (
            <span className="pdash__hero-metric">{hasAggregates ? "集計済み" : "未集計"}</span>
          )}
        </div>
        {pct != null && (
          <div
            className="pdash__progress"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="回答率"
          >
            <div className="pdash__progress-bar" style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
        )}
        {lastNotify && (
          <p className="pdash__hero-note">
            配信結果：対象 {lastNotify.targets} 名 ／ Slack 成功 {lastNotify.slack_ok}
            {lastNotify.slack_fail > 0 && `・失敗 ${lastNotify.slack_fail}`} ／ メール成功 {lastNotify.email_ok}
            {lastNotify.email_fail > 0 && `・失敗 ${lastNotify.email_fail}`}
          </p>
        )}
      </div>
      {cycle.status === "sent" && (
        <div className="pdash__hero-actions">
          <button className="pdash__btn" onClick={onRemind} disabled={notifying}>
            {notifying ? "送信中…" : "リマインド送信"}
          </button>
          <button className="pdash__btn pdash__btn--primary" onClick={onClose} disabled={closing}>
            {closing ? "処理中…" : "受付を終了"}
          </button>
        </div>
      )}
    </section>
  );
}

// ── オンボーディング（4ステップ） ───────────────────────────────────

function Onboarding({
  cycles,
  activeSetCount,
  onOpenAdmin,
}: {
  cycles: PulseCycleRow[];
  activeSetCount: number | null;
  onOpenAdmin: () => void;
}) {
  // 進行中サイクル（scheduled/sent）が無い状態でのみ表示される。
  // ＝ステップ②以降は必ず未完了。ステップ①は「サイクルが1つでもあれば通過済み」と
  // みなす（設問セットの参照権限が無い閲覧者でも現在地を誤判定しないため）。
  const setDone = (activeSetCount ?? 0) > 0 || cycles.length > 0;
  const steps = [
    { title: "設問セットを有効化", desc: "設問を作って active にする（有効化後は編集不可）", done: setDone },
    { title: "サイクルを作成", desc: "対象月・締切日・使う設問セットを決める", done: false },
    { title: "受付開始", desc: "サイクルを「受付中」にする（この時点では通知は飛びません）", done: false },
    { title: "一斉送信", desc: "Slack／メールで回答URLを配信する", done: false },
  ];
  const current = setDone ? 1 : 0;

  return (
    <section className="pdash__onb" aria-label="パルスサーベイの立ち上げ手順">
      <div className="pdash__onb-head">
        <h2 className="pdash__h2">パルスサーベイを始める</h2>
        <p className="pdash__muted">
          {cycles.length === 0
            ? "まだサイクルがありません。次の4ステップで運用を開始できます。"
            : "進行中のサイクルがありません。次の対象月のサイクルを作成しましょう。"}
        </p>
      </div>
      <ol className="pdash__steps">
        {steps.map((s, i) => {
          const state = s.done ? "is-done" : i === current ? "is-current" : "is-todo";
          return (
            <li key={s.title} className={`pdash__step ${state}`}>
              <span className="pdash__step-num" aria-hidden>
                {s.done ? <Check size={14} /> : i + 1}
              </span>
              <span className="pdash__step-body">
                <span className="pdash__step-title">{s.title}</span>
                <span className="pdash__step-desc">{s.desc}</span>
              </span>
              {i === current && <span className="pdash__step-here">いまここ</span>}
            </li>
          );
        })}
      </ol>
      <button className="pdash__btn pdash__btn--primary pdash__onb-cta" onClick={onOpenAdmin}>
        <Settings size={14} aria-hidden /> 設定を開く
      </button>
    </section>
  );
}

// ── 指標カード ───────────────────────────────────────────────────────

type DeltaDir = "up" | "down" | "flat" | "none";

/** 現在値と前回値から矢印の向きを決める（|差| < eps は flat）。 */
function deltaOf(cur: number | null, prev: number | null, eps: number): DeltaDir {
  if (cur == null || prev == null) return "none";
  if (cur - prev > eps) return "up";
  if (prev - cur > eps) return "down";
  return "flat";
}

/** 前回比の差分テキスト（"+0.12" など）。比較不能なら null。 */
function fmtDelta(cur: number | null, prev: number | null, fmt: (v: number) => string): string | null {
  if (cur == null || prev == null) return null;
  const d = cur - prev;
  return `${d >= 0 ? "+" : "−"}${fmt(Math.abs(d))}`;
}

function Stat({
  label,
  value,
  sub,
  accent,
  warn,
  icon,
  delta = "none",
  deltaText,
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  warn?: boolean;
  icon?: ReactNode;
  delta?: DeltaDir;
  deltaText?: string | null;
  onClick?: () => void;
}) {
  const cls =
    "pdash__stat" +
    (accent ? " is-accent" : "") +
    (warn ? " is-warn" : "") +
    (onClick ? " is-clickable" : "");
  const body = (
    <>
      <div className="pdash__stat-label">
        {icon}
        {label}
        {onClick && <ArrowUpRight size={13} className="pdash__stat-go" aria-hidden />}
      </div>
      <div className="pdash__stat-value">
        {value}
        {delta !== "none" && (
          <span className={`pdash__delta is-${delta}`} title={deltaText ? `前回比 ${deltaText}` : undefined}>
            {delta === "up" ? <ArrowUp size={13} /> : delta === "down" ? <ArrowDown size={13} /> : <Minus size={13} />}
            {deltaText && <span className="pdash__delta-text">{deltaText}</span>}
          </span>
        )}
      </div>
      {sub && <div className="pdash__stat-sub">{sub}</div>}
    </>
  );
  if (onClick) {
    return (
      <button type="button" className={cls} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={cls}>{body}</div>;
}

// ── チャート ─────────────────────────────────────────────────────────

/** 天気5段階の横棒（score 5→1）＋割合。 */
function WeatherDist({ dist }: { dist: Record<string, number> }) {
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  if (total === 0) return <p className="pdash__muted">回答なし（または n&lt;5 のためマスク中）</p>;
  const max = Math.max(1, ...Object.values(dist));
  return (
    <div className="pdash__wdist">
      {WEATHER_SCALE.map((w) => {
        const c = dist[String(w.score)] ?? 0;
        const pct = Math.round((c / total) * 100);
        return (
          <div key={w.score} className="pdash__wrow">
            <span className="pdash__wlabel">
              <span aria-hidden>{w.emoji}</span> {w.label}
            </span>
            <div className="pdash__wbar-track">
              <div className={`pdash__wbar pdash__wbar--${w.score}`} style={{ width: `${(c / max) * 100}%` }} />
            </div>
            <span className="pdash__wcount">
              {c}
              <span className="pdash__wpct">{pct}%</span>
            </span>
          </div>
        );
      })}
      <p className="pdash__legend">回答 {total} 件（棒の長さは最多段階を100%とした相対値）</p>
    </div>
  );
}

/** カテゴリ別平均バー（5点満点・平均降順）。 */
function CategoryBars({ entries }: { entries: [string, { avg: number; n: number }][] }) {
  if (entries.length === 0) return <p className="pdash__muted">データなし（n&lt;5 のためマスク中の可能性があります）</p>;
  return (
    <div className="pdash__bars">
      {entries.map(([cat, m]) => (
        <div key={cat} className="pdash__bar-row">
          <span className="pdash__bar-label" title={cat}>
            {cat}
          </span>
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
  const hasEnps = rows.some((r) => r.metrics.enps_n != null && r.metrics.enps_n > 0);
  return (
    <div className="pdash__bars">
      {rows.map((r) => (
        <div key={r.id} className="pdash__bar-row">
          <span className="pdash__bar-label" title={r.dimension_key}>
            {r.dimension_key}
          </span>
          {r.metrics.masked ? (
            <div className="pdash__bar-track pdash__bar-track--masked">
              <span className="pdash__mask-chip">
                <Lock size={11} aria-hidden /> n&lt;5
              </span>
              <span className="pdash__masked">プライバシー保護のため非表示</span>
            </div>
          ) : (
            <div className="pdash__bar-track">
              <div className="pdash__bar" style={{ width: `${((r.metrics.avg_overall ?? 0) / 5) * 100}%` }}>
                <span className="pdash__bar-val">{r.metrics.avg_overall?.toFixed(2)}</span>
              </div>
            </div>
          )}
          <span className="pdash__bar-n">
            n={r.metrics.n}
            {hasEnps && (
              <span className="pdash__enps-chip">
                eNPS{" "}
                {r.metrics.enps_n == null || r.metrics.enps_n === 0
                  ? "—"
                  : r.metrics.enps_masked
                    ? "n<5"
                    : `${(r.metrics.enps ?? 0) > 0 ? "+" : ""}${r.metrics.enps}`}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * 汎用スパークライン（SVG・依存なし）。
 * y軸は min/max 固定＋目盛ラベル、各点に丸、最新値は強調して数値を添える。
 */
function Sparkline({
  data,
  min,
  max,
  guides,
  zeroGuide,
  format,
  formatAxis,
  ariaLabel,
}: {
  data: { period: string; value: number }[];
  min: number;
  max: number;
  guides: number[];
  zeroGuide?: boolean;
  format: (v: number) => string;
  formatAxis: (v: number) => string;
  ariaLabel: string;
}) {
  if (data.length === 0) return <p className="pdash__muted">データなし</p>;

  const W = 520;
  const H = 152;
  const PAD = { l: 42, r: 18, t: 18, b: 26 };
  const n = data.length;
  const xs = (i: number) => (n === 1 ? (PAD.l + W - PAD.r) / 2 : PAD.l + (i * (W - PAD.l - PAD.r)) / (n - 1));
  const ys = (v: number) => H - PAD.b - ((v - min) / (max - min)) * (H - PAD.t - PAD.b);
  const line = data.map((p, i) => `${xs(i)},${ys(p.value)}`).join(" ");
  const lastIdx = n - 1;
  // 点が多いときはx軸ラベルを間引く（重なり防止）。
  const labelStep = n <= 8 ? 1 : Math.ceil(n / 8);

  return (
    <div className="pdash__spark-wrap">
      <svg
        className="pdash__spark"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${ariaLabel}（最新 ${format(data[lastIdx].value)}）`}
      >
        {guides.map((g) => (
          <g key={g}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={ys(g)}
              y2={ys(g)}
              className={zeroGuide && g === 0 ? "pdash__grid pdash__grid--zero" : "pdash__grid"}
            />
            <text x={PAD.l - 8} y={ys(g) + 3} className="pdash__spark-y" textAnchor="end">
              {formatAxis(g)}
            </text>
          </g>
        ))}
        {n > 1 && <polyline points={line} className="pdash__spark-line" fill="none" />}
        {data.map((p, i) => (
          <g key={p.period}>
            <circle
              cx={xs(i)}
              cy={ys(p.value)}
              r={i === lastIdx ? 5.5 : 3.5}
              className={i === lastIdx ? "pdash__spark-dot pdash__spark-dot--last" : "pdash__spark-dot"}
            />
            {(i % labelStep === 0 || i === lastIdx) && (
              <text x={xs(i)} y={H - 7} className="pdash__spark-x" textAnchor="middle">
                {p.period.slice(2)}
              </text>
            )}
          </g>
        ))}
        <text
          x={xs(lastIdx)}
          y={Math.max(12, ys(data[lastIdx].value) - 11)}
          className="pdash__spark-last"
          textAnchor={n === 1 ? "middle" : "end"}
        >
          {format(data[lastIdx].value)}
        </text>
      </svg>
      {n === 1 && <p className="pdash__muted pdash__spark-note">推移は2期以上の集計で表示されます。</p>}
    </div>
  );
}

/** 初回ロード中のスケルトン（体感待ち時間を減らす）。 */
function DashSkeleton() {
  return (
    <div aria-hidden>
      <div className="pdash__cards">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="pdash__stat">
            <span className="skl skl--text" style={{ width: "40%" }} />
            <span className="skl" style={{ height: 28, width: "60%", marginTop: 10, display: "block" }} />
            <span className="skl skl--text" style={{ width: "50%", marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="pdash__row">
        {[0, 1].map((i) => (
          <div key={i} className="pdash__panel">
            <span className="skl skl--text" style={{ width: "30%" }} />
            <span className="skl" style={{ height: 120, width: "100%", marginTop: 14, display: "block" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export default PulseDashboardPage;
