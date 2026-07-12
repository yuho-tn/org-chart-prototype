import { useEffect, useState } from "react";
import { usePulseStore } from "../../store/usePulseStore";
import { useAuthStore } from "../../store/useAuthStore";
import { WEATHER_SCALE, periodLabel } from "../../lib/pulse";

/**
 * パルスサーベイ 回答画面（#/survey）。app シェル（SystemSwitcher /
 * GlobalHeader）を持たない chrome 無しルート。認証は必須（App.tsx の
 * session ゲート後に描画）だが、対象社員かどうかはサーバ側
 * （pulse_current_employee_number）が判定する。
 */
export function SurveyPage() {
  const {
    loaded,
    loading,
    error,
    cycle,
    questions,
    eligibility,
    alreadyAnswered,
    answers,
    comment,
    submitting,
    submitted,
    loadSurvey,
    setScore,
    setValueText,
    setComment,
    submit,
  } = usePulseStore();
  const sessionEmail = useAuthStore((s) => s.session?.user?.email ?? null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadSurvey();
  }, [loadSurvey]);

  const onSubmit = async () => {
    const res = await submit();
    if (!res.ok) setToast(res.reason ?? "送信に失敗しました");
  };

  // スコア設問（天気・スケール・eNPS）は必須扱い：全てに score が要る。
  const scoredQs = questions.filter(
    (q) => q.type === "weather5" || q.type === "scale" || q.type === "nps",
  );
  const missingRequired = scoredQs.some((q) => answers[q.id]?.score == null);

  return (
    <div className="pulse">
      <div className="pulse__card">
        <header className="pulse__head">
          <div className="pulse__brand">パルスサーベイ</div>
          {cycle && <div className="pulse__period">{periodLabel(cycle.period)}</div>}
          {sessionEmail && <div className="pulse__who">{sessionEmail}</div>}
        </header>

        {/* ── 各状態 ── */}
        {!loaded && loading && <p className="pulse__muted">読み込み中…</p>}

        {loaded && error && <p className="pulse__error">{error}</p>}

        {loaded && !error && !cycle && (
          <div className="pulse__empty">
            <div className="pulse__empty-emoji">🌙</div>
            <p>いま回答受付中のサーベイはありません。</p>
            <p className="pulse__muted">配信のお知らせが届いたら、また開いてください。</p>
          </div>
        )}

        {loaded && !error && cycle && eligibility === "not_target" && (
          <div className="pulse__empty">
            <div className="pulse__empty-emoji">🔒</div>
            <p>このアカウントはサーベイの回答対象として登録されていません。</p>
            <p className="pulse__muted">
              社員メールでログインしているかご確認ください。心当たりがなければ人事までご連絡ください。
            </p>
          </div>
        )}

        {loaded && !error && cycle && eligibility === "eligible" && submitted && (
          <div className="pulse__empty">
            <div className="pulse__empty-emoji">✅</div>
            <p>回答ありがとうございました！</p>
            <p className="pulse__muted">
              締切（{cycle.due_date ?? "設定なし"}）まではこの画面から何度でも修正できます。
            </p>
            <button className="pulse__btn pulse__btn--ghost" onClick={() => loadSurvey()}>
              回答を見直す
            </button>
          </div>
        )}

        {loaded && !error && cycle && eligibility === "eligible" && !submitted && (
          <>
            <p className="pulse__lead">
              いまの調子を天気で教えてください。所要 1 分・匿名集計されます。
              {alreadyAnswered && (
                <span className="pulse__badge">回答済み（修正できます）</span>
              )}
            </p>

            <div className="pulse__questions">
              {questions.map((q) => (
                <section key={q.id} className="pulse__q">
                  <div className="pulse__q-label">
                    {q.category && <span className="pulse__q-cat">{q.category}</span>}
                    {q.label}
                  </div>

                  {q.type === "free_text" ? (
                    <textarea
                      className="pulse__textarea"
                      rows={3}
                      placeholder="自由記述（任意）"
                      value={answers[q.id]?.value_text ?? ""}
                      onChange={(e) => setValueText(q.id, e.target.value)}
                    />
                  ) : q.type === "nps" ? (
                    <div className="pulse__nps" role="radiogroup" aria-label={q.label}>
                      <div className="pulse__nps-row">
                        {Array.from({ length: 11 }, (_, i) => i).map((n) => {
                          const active = answers[q.id]?.score === n;
                          return (
                            <button
                              key={n}
                              type="button"
                              role="radio"
                              aria-checked={active}
                              className={"pulse__nps-opt" + (active ? " is-active" : "")}
                              onClick={() => setScore(q.id, n)}
                            >
                              {n}
                            </button>
                          );
                        })}
                      </div>
                      <div className="pulse__nps-legend">
                        <span>0 = まったく勧めない</span>
                        <span>10 = 強く勧める</span>
                      </div>
                    </div>
                  ) : (
                    <div className="pulse__weather" role="radiogroup" aria-label={q.label}>
                      {WEATHER_SCALE.map((w) => {
                        const active = answers[q.id]?.score === w.score;
                        return (
                          <button
                            key={w.score}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            className={
                              "pulse__weather-opt" + (active ? " is-active" : "")
                            }
                            onClick={() => setScore(q.id, w.score)}
                          >
                            <span className="pulse__weather-emoji">{w.emoji}</span>
                            <span className="pulse__weather-txt">{w.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
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
                disabled={submitting || missingRequired || questions.length === 0}
                onClick={onSubmit}
              >
                {submitting ? "送信中…" : alreadyAnswered ? "回答を更新する" : "回答を送信する"}
              </button>
              {missingRequired && (
                <span className="pulse__hint">スコアの設問にすべて答えてください</span>
              )}
            </div>
          </>
        )}
      </div>

      {toast && (
        <div className="pulse__toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

export default SurveyPage;
