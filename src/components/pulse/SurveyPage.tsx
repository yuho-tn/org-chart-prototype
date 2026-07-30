import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
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
import { WEATHER_SCALE, periodLabel, type PulseQuestionRow } from "../../lib/pulse";
import { usePulseToast, PulseToast } from "./usePulseToast";

/**
 * パルスサーベイ 回答画面（#/survey）。app シェル（SystemSwitcher /
 * GlobalHeader）を持たない chrome 無しルート。認証は必須（App.tsx の
 * session ゲート後に描画）だが、対象社員かどうかはサーバ側
 * （pulse_current_employee_number）が判定する。
 *
 * v2（設計書 §4）: 社員が触る唯一の画面なのでモバイル前提で作り込む。
 *   - scale 型専用UI（1〜5 数値セグメント）を weather5 と分離
 *   - 回答進捗バー＋未回答設問へのスムーズスクロール
 *   - 送信後サンクス画面に「マイパルス」（本人の推移）
 *   - ホーム / 管理ダッシュボード / サインアウトの導線を常設（行き止まり禁止）
 */

/** scale 型（5段階）の選択肢。1=そう思わない … 5=とてもそう思う。 */
const SCALE_STEPS = [1, 2, 3, 4, 5];

/** "YYYY-MM" → "26/7"（スパークラインの軸ラベル用の短縮表記）。 */
function periodShort(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  return m ? `${m[1].slice(2)}/${Number(m[2])}` : period;
}

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

export function SurveyPage() {
  const {
    loaded,
    error,
    cycle,
    questions,
    eligibility,
    alreadyAnswered,
    answers,
    comment,
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
  const role = useAuthStore((s) => s.currentUser?.role);
  const signOut = useAuthStore((s) => s.signOut);
  const navigate = useUiStore((s) => s.navigate);
  const { toast, showToast, clearToast } = usePulseToast();

  /** 未回答のまま送信された設問（強調表示用）。 */
  const [missId, setMissId] = useState<string | null>(null);
  /** 設問カードの DOM 参照（未回答スクロール用）。 */
  const qRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    loadSurvey();
  }, [loadSurvey]);

  // サンクス画面に入ったらマイパルスを取得（送信直後は historyLoaded=false）。
  useEffect(() => {
    if (submitted && !historyLoaded) loadMyHistory();
  }, [submitted, historyLoaded, loadMyHistory]);

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
          {sessionEmail && <div className="pulse__who">{sessionEmail}</div>}
        </header>

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

        {loaded && !error && !cycle && (
          <div className="pulse__empty">
            <MoonStar className="pulse__empty-icon" size={40} aria-hidden />
            <p>いま回答受付中のサーベイはありません。</p>
            <p className="pulse__muted">配信のお知らせが届いたら、また開いてください。</p>
          </div>
        )}

        {loaded && !error && cycle && eligibility === "not_target" && (
          <div className="pulse__empty">
            <ShieldAlert className="pulse__empty-icon" size={40} aria-hidden />
            <p>このアカウントはサーベイの回答対象として登録されていません。</p>
            <p className="pulse__muted">
              社員メールでログインしているかご確認ください。心当たりがなければ人事までご連絡ください。
            </p>
            <button className="pulse__btn pulse__btn--ghost" onClick={() => signOut()}>
              <LogOut size={15} aria-hidden />
              別のアカウントでログインする
            </button>
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

            <MyPulse history={history} />
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

      {/* 行き止まり禁止: どの状態でもホーム（＋権限があれば管理）へ戻れる。 */}
      <footer className="pulse__foot">
        <button className="pulse__foot-link" onClick={() => navigate({ name: "home" })}>
          <Home size={14} aria-hidden />
          ホームへ
        </button>
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
  q: PulseQuestionRow;
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
 * マイパルス（サンクス画面）。本人の回答推移だけを描く。
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
  const latestCats = useMemo(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      const cats = history[i].by_category;
      if (cats && Object.keys(cats).length > 0) {
        return { period: history[i].period, entries: Object.entries(cats) };
      }
    }
    return null;
  }, [history]);

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
