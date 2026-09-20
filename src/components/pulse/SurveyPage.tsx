import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  CheckCircle2,
  Eye,
  Home,
  LogOut,
  MoonStar,
  ShieldAlert,
} from "lucide-react";
import "./survey.css";
import { usePulseStore, type PulseMyHistoryPoint } from "../../store/usePulseStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useUiStore } from "../../store/useUiStore";
import { canAccessPulse } from "../../lib/supabase";
import {
  PULSE_ANSWER_ERROR_MESSAGE,
  WEATHER_SCALE,
  periodLabel,
  periodShort,
  weatherForScore,
  type PulseAnswerInput,
  type PulseSurveyBundleQuestion,
  type PulseSurveyPrevious,
  type PulseSurveyViewers,
} from "../../lib/pulse";
import { usePulseToast, PulseToast } from "./usePulseToast";

/**
 * パルスサーベイ 回答画面（#/survey・#/survey?t=<token>）。app シェル（SystemSwitcher /
 * GlobalHeader）を持たない chrome 無しルート。
 *
 * v3（設計書 §5-3）: `token` prop が渡されればログイン不要の本人専用トークン経路
 * （App.tsx が認証ゲートより前で描画する）。渡されなければ従来どおりログイン必須
 * （session ゲート後に描画・pulse_my_survey 経由）。どちらも usePulseStore が同じ
 * bundle 形にまとめるので、このコンポーネント自体は表示ロジックのみに専念する。
 *
 * v2（設計書 §4）由来: モバイル前提の作り込み・scale型専用UI・進捗バー・マイパルス。
 */

/** scale 型（5段階）の選択肢。1=そう思わない … 5=とてもそう思う。 */
const SCALE_STEPS = [1, 2, 3, 4, 5];

/** 締切日（YYYY-MM-DD）を「8/25（あと3日）」に整形。days<=1 は急ぎ扱い。 */
function dueInfo(due: string | null): { text: string; urgent: boolean } | null {
  if (!due) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return { text: due, urgent: false };
  const md = `${Number(m[2])}/${Number(m[3])}`;
  const target = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days > 1) return { text: `${md}（あと${days}日）`, urgent: false };
  if (days === 1) return { text: `${md}（あと1日）`, urgent: true };
  if (days === 0) return { text: `${md}（本日まで）`, urgent: true };
  return { text: `${md}（締切超過）`, urgent: true };
}

export function SurveyPage({ token }: { token?: string } = {}) {
  const {
    loaded,
    error,
    tokenErrorCode,
    cycle,
    questions,
    eligibility,
    alreadyAnswered,
    answers,
    comment,
    displayName,
    viewers,
    previous,
    submitting,
    submitted,
    history,
    historyLoaded,
    loadSurvey,
    loadMyHistory,
    setScore,
    setValueText,
    setComment,
    submit,
  } = usePulseStore();
  const sessionEmail = useAuthStore((s) => s.session?.user?.email ?? null);
  const hasSession = useAuthStore((s) => !!s.session);
  const role = useAuthStore((s) => s.currentUser?.role);
  const signOut = useAuthStore((s) => s.signOut);
  const navigate = useUiStore((s) => s.navigate);
  const { toast, showToast, clearToast } = usePulseToast();

  /** 未回答のまま送信された設問（強調表示用）。 */
  const [missId, setMissId] = useState<string | null>(null);
  /** 設問カードの DOM 参照（未回答スクロール用）。 */
  const qRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    // token モードでは Edge Function 経由・セッションモードでは pulse_my_survey 経由。
    loadSurvey({ token });
  }, [loadSurvey, token]);

  // サンクス画面に入ったらマイパルスを取得（送信直後は historyLoaded=false）。
  // token モードでは呼ばない（決定2＝履歴の閲覧はログイン必須・SurveyHistoryPage 参照）。
  useEffect(() => {
    if (!token && submitted && !historyLoaded) loadMyHistory();
  }, [token, submitted, historyLoaded, loadMyHistory]);

  // スコア設問（天気・スケール・eNPS）は必須。free_text は任意なので進捗の分母から外す。
  const scoredQs = useMemo(
    () => questions.filter((q) => q.type !== "free_text"),
    [questions],
  );
  const answeredCount = useMemo(
    () => scoredQs.filter((q) => answers[q.id]?.score != null).length,
    [scoredQs, answers],
  );
  const firstMissing = scoredQs.find((q) => answers[q.id]?.score == null) ?? null;
  const progressPct = scoredQs.length === 0 ? 0 : (answeredCount / scoredQs.length) * 100;

  /** 選択と同時に「未回答」強調を解除する。 */
  const pickScore = (questionId: string, score: number) => {
    setScore(questionId, score);
    if (missId === questionId) setMissId(null);
  };

  const onSubmit = async () => {
    // 未回答があれば送信せず、最初の未回答設問までスクロールして強調する。
    if (firstMissing) {
      setMissId(firstMissing.id);
      qRefs.current[firstMissing.id]?.scrollIntoView({ behavior: "smooth", block: "center" });
      showToast("error", "未回答の設問があります");
      return;
    }
    const res = await submit();
    if (!res.ok) {
      showToast("error", res.reason ?? "送信に失敗しました");
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const due = dueInfo(cycle?.due_date ?? null);
  const showPulseAdminLink = canAccessPulse(role);
  // token モードで「未ログイン」の場合のみ行き止まり回避のリンクを出す（既にログイン
  // 済みでたまたま自分宛のリンクを開いた場合はセッションモードと同じ導線でよい）。
  const showHomeLink = !token || hasSession;

  return (
    <div className="pulse">
      <div className="pulse__card">
        <header className="pulse__head">
          <div className="pulse__brand">
            <span className="pulse__brand-sys">SHO-SAN TalentHub</span>
            <span className="pulse__brand-name">パルスサーベイ</span>
          </div>
          <div className="pulse__head-meta">
            {cycle && <span className="pulse__period">{periodLabel(cycle.period)}</span>}
            {cycle && due && (
              <span className={"pulse__due" + (due.urgent ? " is-urgent" : "")}>
                <CalendarClock size={13} aria-hidden />
                締切 {due.text}
              </span>
            )}
          </div>
          {(sessionEmail || displayName) && (
            <div className="pulse__who">{sessionEmail ?? displayName}</div>
          )}
        </header>

        {/* 閲覧者の明示（決定1）。bundle が cycle 付きで取れている間だけ表示。 */}
        {viewers && <ViewerNotice viewers={viewers} tokenMode={!!token} />}

        {/* ── 各状態 ── */}
        {/* 初回マウントは loaded=false のあいだ必ずスケルトン（1フレームの空白を出さない）。 */}
        {!loaded && (
          <div className="pulse__skeleton" aria-hidden>
            <div className="skl skl--text pulse__skl-lead" />
            <div className="skl pulse__skl-q" />
            <div className="skl pulse__skl-q" />
            <div className="skl pulse__skl-q" />
          </div>
        )}

        {loaded && error && (
          <div className="pulse__empty">
            <p className="pulse__error">{error}</p>
            <button className="pulse__btn pulse__btn--ghost" onClick={() => loadSurvey()}>
              再読み込み
            </button>
          </div>
        )}

        {loaded && !error && !cycle && eligibility !== "not_target" && !tokenErrorCode && (
          <div className="pulse__empty">
            <MoonStar className="pulse__empty-icon" size={40} aria-hidden />
            <p>いま回答受付中のサーベイはありません。</p>
            <p className="pulse__muted">配信のお知らせが届いたら、また開いてください。</p>
          </div>
        )}

        {/* token モードのエラー（改竄・期限切れ・受付終了・対象外・不明）。行き止まりにしない。 */}
        {loaded && !error && token && tokenErrorCode && (
          <div className="pulse__empty">
            <ShieldAlert className="pulse__empty-icon" size={40} aria-hidden />
            <p>{PULSE_ANSWER_ERROR_MESSAGE[tokenErrorCode]}</p>
            <button
              className="pulse__btn pulse__btn--ghost"
              onClick={() => navigate({ name: "survey" })}
            >
              ログインして開く
            </button>
          </div>
        )}

        {loaded && !error && eligibility === "not_target" && (
          <div className="pulse__empty">
            <ShieldAlert className="pulse__empty-icon" size={40} aria-hidden />
            <p>このアカウントはサーベイの回答対象として登録されていません。</p>
            <p className="pulse__muted">
              社員メールでログインしているかご確認ください。心当たりがなければ人事までご連絡ください。
            </p>
            {hasSession && (
              <button className="pulse__btn pulse__btn--ghost" onClick={() => signOut()}>
                <LogOut size={15} aria-hidden />
                別のアカウントでログインする
              </button>
            )}
          </div>
        )}

        {loaded && !error && cycle && eligibility === "eligible" && submitted && (
          <div className="pulse__thanks">
            <CheckCircle2 className="pulse__thanks-icon" size={46} aria-hidden />
            <p className="pulse__thanks-title">回答ありがとうございました！</p>
            <p className="pulse__muted">
              締切（{cycle.due_date ?? "設定なし"}）まではこの画面から何度でも修正できます。
            </p>
            <button className="pulse__btn pulse__btn--ghost" onClick={() => loadSurvey()}>
              回答を見直す
            </button>

            <PreviousComparison previous={previous} questions={questions} answers={answers} />

            <button
              className="pulse__btn pulse__btn--ghost"
              onClick={() => navigate({ name: "survey_history" })}
            >
              振り返りを見る
            </button>
            {!hasSession && (
              <p className="pulse__muted pulse__compare-loginhint">
                振り返りの閲覧にはログインが必要です
              </p>
            )}

            {!token && <MyPulse history={history} />}
          </div>
        )}

        {loaded && !error && cycle && eligibility === "eligible" && !submitted && (
          <>
            <p className="pulse__lead">
              いまの調子を教えてください。所要 1 分・匿名集計されます。
              {alreadyAnswered && (
                <span className="pulse__badge">回答済み（修正できます）</span>
              )}
            </p>

            {scoredQs.length > 0 && (
              <div className="pulse__progress">
                <div className="pulse__progress-row">
                  <span className="pulse__progress-txt">
                    {scoredQs.length}問中{answeredCount}問回答済み
                  </span>
                  {answeredCount === scoredQs.length && (
                    <span className="pulse__progress-done">送信できます</span>
                  )}
                </div>
                <div
                  className="pulse__progress-bar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={scoredQs.length}
                  aria-valuenow={answeredCount}
                  aria-label="回答進捗"
                >
                  <span
                    className="pulse__progress-fill"
                    style={{ width: `${progressPct}%` }}
                  />
                </div>
              </div>
            )}

            <div className="pulse__questions">
              {questions.map((q, i) => (
                <QuestionCard
                  key={q.id}
                  q={q}
                  index={i + 1}
                  score={answers[q.id]?.score ?? null}
                  valueText={answers[q.id]?.value_text ?? ""}
                  missing={missId === q.id}
                  onPick={pickScore}
                  onText={setValueText}
                  registerRef={(el) => {
                    qRefs.current[q.id] = el;
                  }}
                />
              ))}
            </div>

            <section className="pulse__q">
              <div className="pulse__q-label">ひとことコメント（任意）</div>
              <textarea
                className="pulse__textarea"
                rows={3}
                placeholder="いま感じていること・共有したいことがあれば自由にどうぞ"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </section>

            <div className="pulse__actions">
              <button
                className="pulse__btn pulse__btn--primary"
                disabled={submitting || questions.length === 0}
                onClick={onSubmit}
              >
                {submitting ? "送信中…" : alreadyAnswered ? "回答を更新する" : "回答を送信する"}
              </button>
              {firstMissing && (
                <span className="pulse__hint">
                  未回答が{scoredQs.length - answeredCount}問あります
                </span>
              )}
            </div>
          </>
        )}
      </div>

      {/* 行き止まり禁止: どの状態でもホーム（＋権限があれば管理）へ戻れる。
          token モードでセッションが無い場合はホームへ戻ってもサインイン画面に
          流れるだけなので、その場合は「ログインして開く」導線に一本化する。 */}
      <footer className="pulse__foot">
        {showHomeLink && (
          <button className="pulse__foot-link" onClick={() => navigate({ name: "home" })}>
            <Home size={14} aria-hidden />
            ホームへ
          </button>
        )}
        {showPulseAdminLink && (
          <button className="pulse__foot-link" onClick={() => navigate({ name: "pulse" })}>
            <Activity size={14} aria-hidden />
            管理ダッシュボードへ
          </button>
        )}
      </footer>

      <PulseToast toast={toast} onDismiss={clearToast} className="pulse__toast" />
    </div>
  );
}

/**
 * 閲覧者の明示（決定1）。回答画面冒頭で「誰がこの回答を見るか」を必ず提示する。
 * token モードでは「このURLはあなた専用です」を小さく併記する。
 */
function ViewerNotice({ viewers, tokenMode }: { viewers: PulseSurveyViewers; tokenMode: boolean }) {
  return (
    <div className="pulse__viewers">
      <Eye className="pulse__viewers-icon" size={15} aria-hidden />
      <div className="pulse__viewers-text">
        <p>
          {viewers.notice}
          {viewers.manager_disclosure && viewers.manager_names.length > 0 && (
            <> 上長（{viewers.manager_names.join("・")}）も閲覧します。</>
          )}
        </p>
        {tokenMode && <p className="pulse__viewers-token">このURLはあなた専用です（転送しないでください）。</p>}
      </div>
    </div>
  );
}

/**
 * 設問カード1枚。type で入力UIを出し分ける。
 *   weather5 = 天気5段階（絵文字は既存仕様として維持）
 *   scale    = 1〜5 の数値セグメント（v2 で新設・weather5 と分離）
 *   nps      = 0〜10 ＋ 両端ラベル
 *   free_text= 自由記述（任意・進捗の分母外）
 */
function QuestionCard({
  q,
  index,
  score,
  valueText,
  missing,
  onPick,
  onText,
  registerRef,
}: {
  q: PulseSurveyBundleQuestion;
  index: number;
  score: number | null;
  valueText: string;
  missing: boolean;
  onPick: (questionId: string, score: number) => void;
  onText: (questionId: string, value: string) => void;
  registerRef: (el: HTMLElement | null) => void;
}) {
  const answered = q.type !== "free_text" && score != null;
  return (
    <section
      ref={registerRef}
      className={
        "pulse__q pulse__q--card" +
        (missing ? " is-missing" : "") +
        (answered ? " is-answered" : "")
      }
      aria-invalid={missing || undefined}
    >
      <div className="pulse__q-head">
        <span className="pulse__q-no">Q{index}</span>
        {q.category && <span className="pulse__q-cat">{q.category}</span>}
        {q.type === "free_text" && <span className="pulse__q-opt">任意</span>}
      </div>
      <div className="pulse__q-label">{q.label}</div>

      {q.type === "free_text" ? (
        <textarea
          className="pulse__textarea"
          rows={3}
          placeholder="自由記述（任意）"
          value={valueText}
          onChange={(e) => onText(q.id, e.target.value)}
        />
      ) : q.type === "nps" ? (
        <div className="pulse__nps" role="radiogroup" aria-label={q.label}>
          <div className="pulse__nps-row">
            {Array.from({ length: 11 }, (_, n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={score === n}
                className={"pulse__nps-opt" + (score === n ? " is-active" : "")}
                onClick={() => onPick(q.id, n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="pulse__scale-legend">
            <span>0 = 全く勧めない</span>
            <span>10 = 強く勧める</span>
          </div>
        </div>
      ) : q.type === "scale" ? (
        <div className="pulse__scale" role="radiogroup" aria-label={q.label}>
          <div className="pulse__scale-row">
            {SCALE_STEPS.map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={score === n}
                className={"pulse__scale-opt" + (score === n ? " is-active" : "")}
                onClick={() => onPick(q.id, n)}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="pulse__scale-legend">
            <span>1 = そう思わない</span>
            <span>5 = とてもそう思う</span>
          </div>
        </div>
      ) : (
        <div className="pulse__weather" role="radiogroup" aria-label={q.label}>
          {WEATHER_SCALE.map((w) => (
            <button
              key={w.score}
              type="button"
              role="radio"
              aria-checked={score === w.score}
              className={"pulse__weather-opt" + (score === w.score ? " is-active" : "")}
              onClick={() => onPick(q.id, w.score)}
            >
              <span className="pulse__weather-emoji">{w.emoji}</span>
              <span className="pulse__weather-txt">{w.label}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * 前回との比較（送信後サンクス画面・設計書 §5-3）。カテゴリ別に前回→今回の天気を
 * 矢印付きで並べ、eNPS も1行添える。previous が無ければ初回向けの案内文だけ出す。
 */
function PreviousComparison({
  previous,
  questions,
  answers,
}: {
  previous: PulseSurveyPrevious | null;
  questions: PulseSurveyBundleQuestion[];
  answers: Record<string, PulseAnswerInput>;
}) {
  // 今回の回答をカテゴリ別平均に集計（weather5/scale のみ・nps/free_text は除く）。
  const currentByCategory = useMemo(() => {
    const sums: Record<string, { total: number; n: number }> = {};
    for (const q of questions) {
      if (!q.category || q.type === "free_text" || q.type === "nps") continue;
      const score = answers[q.id]?.score;
      if (score == null) continue;
      const bucket = (sums[q.category] ??= { total: 0, n: 0 });
      bucket.total += score;
      bucket.n += 1;
    }
    const out: Record<string, number> = {};
    for (const [cat, { total, n }] of Object.entries(sums)) out[cat] = total / n;
    return out;
  }, [questions, answers]);

  const currentNps = useMemo(() => {
    const q = questions.find((x) => x.type === "nps");
    return q ? (answers[q.id]?.score ?? null) : null;
  }, [questions, answers]);

  if (!previous) {
    return (
      <section className="pulse__compare">
        <h2 className="pulse__compare-title">前回との比較</h2>
        <p className="pulse__muted">初回の回答です。来月から前回との比較が出ます。</p>
      </section>
    );
  }

  const categories = Object.keys(currentByCategory);

  return (
    <section className="pulse__compare">
      <h2 className="pulse__compare-title">前回との比較（{periodLabel(previous.period)} → 今回）</h2>
      <ul className="pulse__compare-list">
        {categories.map((cat) => {
          const prevScore = previous.by_category[cat];
          const curScore = currentByCategory[cat];
          return (
            <li key={cat} className="pulse__compare-row">
              <span className="pulse__compare-cat">{cat}</span>
              <span className="pulse__compare-vals">
                {prevScore != null ? (
                  <>
                    <WeatherMini score={prevScore} />
                    <TrendArrow prev={prevScore} cur={curScore} />
                  </>
                ) : (
                  <span className="pulse__muted">前回未回答</span>
                )}
                <WeatherMini score={curScore} />
              </span>
            </li>
          );
        })}
        {previous.nps != null && currentNps != null && (
          <li className="pulse__compare-row">
            <span className="pulse__compare-cat">eNPS</span>
            <span className="pulse__compare-vals">
              <span className="pulse__compare-num">{previous.nps}</span>
              <TrendArrow prev={previous.nps} cur={currentNps} />
              <span className="pulse__compare-num">{currentNps}</span>
            </span>
          </li>
        )}
      </ul>
    </section>
  );
}

function WeatherMini({ score }: { score: number }) {
  const w = weatherForScore(score);
  return (
    <span className="pulse__compare-weather" title={w?.label} aria-label={w?.label}>
      {w?.emoji ?? "—"}
    </span>
  );
}

function TrendArrow({ prev, cur }: { prev: number; cur: number }) {
  if (cur - prev > 0.05)
    return <ArrowUp className="pulse__compare-trend is-up" size={14} aria-label="改善" />;
  if (prev - cur > 0.05)
    return <ArrowDown className="pulse__compare-trend is-down" size={14} aria-label="低下" />;
  return <ArrowRight className="pulse__compare-trend is-flat" size={14} aria-label="変化なし" />;
}

/** history 内で直近に by_category を持つ点を新しい方から探す（無ければ null）。 */
function findLatestCategories(
  history: PulseMyHistoryPoint[],
): { period: string; entries: [string, number][] } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const cats = history[i].by_category;
    if (cats && Object.keys(cats).length > 0) {
      return { period: history[i].period, entries: Object.entries(cats) };
    }
  }
  return null;
}

/**
 * マイパルス（サンクス画面・セッションモードのみ）。本人の回答推移だけを描く。
 * 総合スコアのスパークライン＋カテゴリ別最新値＋eNPS推移。履歴 0 件なら非表示。
 */
function MyPulse({ history }: { history: PulseMyHistoryPoint[] }) {
  const overallPts = useMemo(
    () =>
      history
        .filter((h) => h.overall != null)
        .map((h) => ({ period: h.period, value: h.overall as number })),
    [history],
  );
  const npsPts = useMemo(
    () =>
      history
        .filter((h) => h.nps != null)
        .map((h) => ({ period: h.period, value: h.nps as number })),
    [history],
  );
  // 素の計算に降格（useMemo 版は react-hooks/preserve-manual-memoization に
  // 引っかかる＝ React Compiler がこのループ＋早期returnの形を保てず失敗する。
  // history は数か月分程度の小配列なので毎レンダー再計算しても無視できるコスト）。
  const latestCats = findLatestCategories(history);

  if (history.length === 0) return null;

  const lastOverall = overallPts.length ? overallPts[overallPts.length - 1].value : null;
  const lastNps = npsPts.length ? npsPts[npsPts.length - 1].value : null;

  return (
    <section className="pulse__mine">
      <div className="pulse__mine-head">
        <h2 className="pulse__mine-title">マイパルス</h2>
        <span className="pulse__mine-note">あなただけに表示される回答の推移です</span>
      </div>

      {overallPts.length > 0 && (
        <div className="pulse__mine-block">
          <div className="pulse__mine-label">
            総合スコア
            <strong className="pulse__mine-value">{lastOverall?.toFixed(1)}</strong>
            <span className="pulse__mine-unit">/ 5.0</span>
          </div>
          <Spark pts={overallPts} min={1} max={5} label="総合スコアの推移" />
        </div>
      )}

      {latestCats && (
        <div className="pulse__mine-block">
          <div className="pulse__mine-label">
            カテゴリ別（{periodLabel(latestCats.period)}）
          </div>
          <ul className="pulse__cats">
            {latestCats.entries.map(([name, v]) => (
              <li key={name} className="pulse__cat">
                <span className="pulse__cat-name">{name}</span>
                <span className="pulse__cat-bar" aria-hidden>
                  <span
                    className="pulse__cat-fill"
                    style={{ width: `${Math.max(0, Math.min(100, ((v - 1) / 4) * 100))}%` }}
                  />
                </span>
                <span className="pulse__cat-val">{v.toFixed(1)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {npsPts.length > 0 && (
        <div className="pulse__mine-block">
          <div className="pulse__mine-label">
            eNPS（推奨度）
            <strong className="pulse__mine-value">{lastNps}</strong>
            <span className="pulse__mine-unit">/ 10</span>
          </div>
          <Spark pts={npsPts} min={0} max={10} label="eNPSの推移" />
        </div>
      )}
    </section>
  );
}

/**
 * 依存無しの小型スパークライン。点付き・最新値強調・y軸 min/max とx軸の
 * 期間ラベルを表示する（1点だけの場合は点のみ）。
 */
function Spark({
  pts,
  min,
  max,
  label,
}: {
  pts: { period: string; value: number }[];
  min: number;
  max: number;
  label: string;
}) {
  const W = 300;
  const H = 64;
  const padX = 10;
  const padY = 8;
  const x = (i: number) =>
    pts.length === 1 ? W / 2 : padX + (i * (W - padX * 2)) / (pts.length - 1);
  const y = (v: number) => {
    const t = (Math.max(min, Math.min(max, v)) - min) / (max - min);
    return padY + (1 - t) * (H - padY * 2);
  };
  const line = pts.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const lastIdx = pts.length - 1;

  return (
    <div className="pulse__spark-wrap">
      <div className="pulse__spark-axis" aria-hidden>
        <span>{max}</span>
        <span>{min}</span>
      </div>
      <div className="pulse__spark-body">
        <svg
          className="pulse__spark"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
        >
          {pts.length > 1 && <polyline className="pulse__spark-line" points={line} fill="none" />}
          {pts.map((p, i) => (
            <circle
              key={p.period}
              className={"pulse__spark-dot" + (i === lastIdx ? " is-last" : "")}
              cx={x(i)}
              cy={y(p.value)}
              r={i === lastIdx ? 4 : 2.5}
            />
          ))}
        </svg>
        <div className="pulse__spark-x" aria-hidden>
          <span>{periodShort(pts[0].period)}</span>
          {pts.length > 1 && <span>{periodShort(pts[lastIdx].period)}</span>}
        </div>
      </div>
    </div>
  );
}

export default SurveyPage;
