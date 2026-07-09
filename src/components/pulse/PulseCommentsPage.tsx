import { useEffect } from "react";
import { usePulseCommentsStore } from "../../store/usePulseCommentsStore";
import { PulseSubnav } from "./PulseSubnav";
import { periodLabel, type PulseCommentRow } from "../../lib/pulse";

/**
 * パルスサーベイ コメント一覧（#/pulse/comments）。
 * admin or pulse_access 保有者向け。投稿者名は実名閲覧権でマスク（無ければ匿名）、
 * 小集団 n<5 は再識別防止で非表示（RPC 側で空を返す）。
 */
export function PulseCommentsPage() {
  const { loaded, loading, error, cycles, selectedPeriod, comments, load, selectPeriod } =
    usePulseCommentsStore();

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ コメント</h1>
          <p className="pdash__sub">自由記述を一覧表示（実名は閲覧権でマスク・小集団 n&lt;5 は非表示）</p>
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
        </div>
      </header>

      <PulseSubnav active="comments" />

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && cycles.length === 0 && (
        <p className="pdash__muted">サーベイのサイクルがまだありません。</p>
      )}

      {loaded && !error && cycles.length > 0 && (
        <>
          <p className="palert__summary">
            {comments.length === 0
              ? "表示できるコメントはありません（未投稿、または小集団 n<5 のためマスク）。"
              : `${comments.length} 件のコメント`}
          </p>
          <div className="pcmt__list">
            {comments.map((c) => (
              <CommentCard key={c.response_id} c={c} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function CommentCard({ c }: { c: PulseCommentRow }) {
  const when = c.answered_at
    ? new Date(c.answered_at).toLocaleDateString("ja-JP", { dateStyle: "short" })
    : "";
  return (
    <section className="pcmt__card">
      <div className="pcmt__meta">
        <span className={"pcmt__author" + (c.author_name ? "" : " is-anon")}>
          {c.author_name ?? "匿名"}
        </span>
        {c.department && <span className="pcmt__dept">{c.department}</span>}
        {when && <span className="pcmt__when">{when}</span>}
      </div>
      <p className="pcmt__body">{c.comment}</p>
    </section>
  );
}

export default PulseCommentsPage;
