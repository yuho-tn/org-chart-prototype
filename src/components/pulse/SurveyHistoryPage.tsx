import { useEffect, useMemo, useState } from "react";
import { ClipboardList, History as HistoryIcon, Home, MoonStar } from "lucide-react";
import "./survey.css";
import "./history.css";
import { supabase, isSupabaseConfigured } from "../../lib/supabase";
import { periodLabel, periodShort, weatherForScore } from "../../lib/pulse";
import { useUiStore } from "../../store/useUiStore";
import type { PulseMyHistoryPoint } from "../../store/usePulseStore";

/**
 * パルスサーベイ 振り返り（#/survey/history）。設計書 v3 §5-4。ログイン必須・
 * chrome 無しのディープリンク（App.tsx が認証ゲート後に単独描画する）。
 *
 * usePulseStore（#/survey フォーム用のストア）とはあえて状態を共有せず、この
 * ページ専用に rpc('pulse_my_history') を直接呼ぶ。usePulseStore は token モード
 * （ログイン不要の本人専用リンク）の `token` を state に保持しており、同一タブ内で
 * token 付き #/survey を経由してからこのページへ来た場合に古い token が残って
 * いる可能性があるため、その状態機械には依存しない方が安全（このページ自体は
 * 常にログイン必須＝セッション専用で問題ない）。
 */

/** 現行「月次パルスサーベイ v1」の固定カテゴリ（設計書 §1）。グリッド／リストの行に使う。 */
const CATEGORY_KEYS = ["仕事", "対人", "健康", "評価"] as const;

function effectiveSumScore(h: PulseMyHistoryPoint): number | null {
  if (h.sum_score != null) return h.sum_score;
  if (!h.by_category) return null;
  const vals = Object.values(h.by_category);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0);
}

function WeatherCell({ score }: { score: number | undefined }) {
  if (score == null) return <span className="pulse-hist__cell-empty">—</span>;
  const w = weatherForScore(score);
  return (
    <span title={w?.label} aria-label={w?.label}>
      {w?.emoji ?? "—"}
    </span>
  );
}

export function SurveyHistoryPage() {
  const navigate = useUiStore((s) => s.navigate);
  const [history, setHistory] = useState<PulseMyHistoryPoint[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isSupabaseConfigured || !supabase) {
        if (!cancelled) {
          setError("Supabase未設定です");
          setState("error");
        }
        return;
      }
      setState("loading");
      const { data, error: rpcError } = await supabase.rpc("pulse_my_history");
      if (cancelled) return;
      if (rpcError) {
        setError(rpcError.message);
        setState("error");
        return;
      }
      setHistory(Array.isArray(data) ? (data as PulseMyHistoryPoint[]) : []);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // rpc は period 昇順（古→新）。表全期間リストは新しい順に見せたいので反転する。
  const descending = useMemo(() => [...history].reverse(), [history]);
  const last6 = useMemo(() => history.slice(-6), [history]);
  const commentCount = useMemo(
    () => history.filter((h) => !!h.comment && h.comment.trim().length > 0).length,
    [history],
  );
  const latestSum = history.length > 0 ? effectiveSumScore(history[history.length - 1]) : null;

  return (
    <div className="pulse">
      <div className="pulse__card pulse-hist__card">
        <header className="pulse__head">
          <div className="pulse__brand">
            <span className="pulse__brand-sys">SHO-SAN TalentHub</span>
            <span className="pulse__brand-name pulse-hist__brand-name">
              <HistoryIcon size={16} aria-hidden />
              振り返り（マイパルス）
            </span>
          </div>
        </header>

        {state === "loading" && (
          <div className="pulse__skeleton" aria-hidden>
            <div className="skl skl--text pulse__skl-lead" />
            <div className="skl pulse__skl-q" />
            <div className="skl pulse__skl-q" />
          </div>
        )}

        {state === "error" && (
          <div className="pulse__empty">
            <p className="pulse__error">{error}</p>
          </div>
        )}

        {state === "ready" && history.length === 0 && (
          <div className="pulse__empty">
            <MoonStar className="pulse__empty-icon" size={40} aria-hidden />
            <p>まだ回答履歴がありません。</p>
            <p className="pulse__muted">回答すると、ここに推移が表示されます。</p>
          </div>
        )}

        {state === "ready" && history.length > 0 && (
          <>
            <div className="pulse-hist__stats">
              <div className="pulse-hist__stat">
                <span className="pulse-hist__stat-label">回答回数</span>
                <span className="pulse-hist__stat-value">{history.length}</span>
              </div>
              <div className="pulse-hist__stat">
                <span className="pulse-hist__stat-label">コメント回数</span>
                <span className="pulse-hist__stat-value">{commentCount}</span>
              </div>
              <div className="pulse-hist__stat">
                <span className="pulse-hist__stat-label">直近の合計</span>
                <span className="pulse-hist__stat-value">
                  {latestSum != null ? latestSum : "—"}
                  <span className="pulse-hist__stat-unit">/20</span>
                </span>
              </div>
            </div>

            <section className="pulse-hist__section">
              <h2 className="pulse-hist__h2">直近6か月の推移</h2>
              <div className="pulse-hist__grid" role="table" aria-label="直近6か月の推移">
                <div className="pulse-hist__grid-row pulse-hist__grid-row--head" role="row">
                  <span className="pulse-hist__grid-cell pulse-hist__grid-cell--label" role="columnheader" />
                  {last6.map((h) => (
                    <span
                      key={h.period}
                      className="pulse-hist__grid-cell pulse-hist__grid-cell--head"
                      role="columnheader"
                    >
                      {periodShort(h.period)}
                    </span>
                  ))}
                </div>
                {CATEGORY_KEYS.map((cat) => (
                  <div key={cat} className="pulse-hist__grid-row" role="row">
                    <span className="pulse-hist__grid-cell pulse-hist__grid-cell--label" role="rowheader">
                      {cat}
                    </span>
                    {last6.map((h) => (
                      <span key={h.period} className="pulse-hist__grid-cell" role="cell">
                        <WeatherCell score={h.by_category?.[cat]} />
                      </span>
                    ))}
                  </div>
                ))}
                <div className="pulse-hist__grid-row" role="row">
                  <span className="pulse-hist__grid-cell pulse-hist__grid-cell--label" role="rowheader">
                    eNPS
                  </span>
                  {last6.map((h) => (
                    <span key={h.period} className="pulse-hist__grid-cell" role="cell">
                      {h.nps ?? "—"}
                    </span>
                  ))}
                </div>
              </div>
            </section>

            <section className="pulse-hist__section">
              <h2 className="pulse-hist__h2">全期間</h2>
              <ul className="pulse-hist__list">
                {descending.map((h) => (
                  <li key={h.cycle_id ?? h.period} className="pulse-hist__item">
                    <div className="pulse-hist__item-top">
                      <span className="pulse-hist__item-period">{periodLabel(h.period)}</span>
                      <span className="pulse-hist__item-weathers">
                        {CATEGORY_KEYS.map((cat) => (
                          <span key={cat} className="pulse-hist__item-w" title={cat}>
                            <WeatherCell score={h.by_category?.[cat]} />
                          </span>
                        ))}
                      </span>
                      <span className="pulse-hist__item-sum">
                        {effectiveSumScore(h) != null ? `${effectiveSumScore(h)}/20` : "—"}
                      </span>
                      <span className="pulse-hist__item-nps">eNPS {h.nps ?? "—"}</span>
                    </div>
                    {h.comment && h.comment.trim().length > 0 && (
                      <details className="pulse-hist__item-comment">
                        <summary>コメントを見る</summary>
                        <p>{h.comment}</p>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>

      <footer className="pulse__foot">
        <button className="pulse__foot-link" onClick={() => navigate({ name: "survey" })}>
          <ClipboardList size={14} aria-hidden />
          回答画面へ
        </button>
        <button className="pulse__foot-link" onClick={() => navigate({ name: "home" })}>
          <Home size={14} aria-hidden />
          ホームへ
        </button>
      </footer>
    </div>
  );
}

export default SurveyHistoryPage;
