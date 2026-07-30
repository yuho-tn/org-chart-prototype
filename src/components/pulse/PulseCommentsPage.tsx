import { useEffect, useMemo, useState } from "react";
import "./pulse-shared.css";
import "./comments.css";
import { usePulseCommentsStore } from "../../store/usePulseCommentsStore";
import { PulseSubnav } from "./PulseSubnav";
import { usePulseToast, PulseToast } from "./usePulseToast";
import { periodLabel, type PulseCommentRow } from "../../lib/pulse";
import { buildCsv, downloadCsv } from "../../lib/pulseCsv";

const DEPT_UNMASKED = "__unmasked__"; // 部署フィルタの選択値: n<5マスクで「—」表示されている行

/**
 * パルスサーベイ コメント一覧（#/pulse/comments）。
 * admin or pulse_access 保有者向け。投稿者名は実名閲覧権でマスク（無ければ匿名）、
 * 小集団 n<5 は再識別防止で非表示（RPC 側で空を返す）。
 * 本文検索＋部署フィルタ（返却データから動的生成）で絞り込みできる。
 */
export function PulseCommentsPage() {
  const { loaded, loading, error, cycles, selectedPeriod, comments, load, selectPeriod } =
    usePulseCommentsStore();
  const { toast, showToast, clearToast } = usePulseToast();
  const [q, setQ] = useState("");
  const [deptFilter, setDeptFilter] = useState("");

  useEffect(() => {
    load();
  }, [load]);

  // selectPeriod や再読込のたびにフィルタを引き継がず、期間が変わったら素直にリセットする。
  useEffect(() => {
    setQ("");
    setDeptFilter("");
  }, [selectedPeriod]);

  const departments = useMemo(() => {
    const set = new Set<string>();
    let hasMasked = false;
    for (const c of comments) {
      if (c.department) set.add(c.department);
      else hasMasked = true;
    }
    const list = Array.from(set).sort((a, b) => a.localeCompare(b, "ja"));
    return { list, hasMasked };
  }, [comments]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return comments.filter((c) => {
      if (needle && !c.comment.toLowerCase().includes(needle)) return false;
      if (deptFilter === DEPT_UNMASKED) return !c.department;
      if (deptFilter && c.department !== deptFilter) return false;
      return true;
    });
  }, [comments, q, deptFilter]);

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
          <input
            className="pcmt__search"
            type="search"
            placeholder="コメント本文で検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="pdash__select"
            value={deptFilter}
            onChange={(e) => setDeptFilter(e.target.value)}
          >
            <option value="">すべての部署</option>
            {departments.list.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
            {departments.hasMasked && <option value={DEPT_UNMASKED}>—（部署非表示）</option>}
          </select>
          <button
            className="pdash__btn"
            disabled={filtered.length === 0}
            onClick={() => {
              // 表示中（検索・フィルタ後）と同じマスク通過データのみ（匿名は「匿名」のまま出力）
              const csv = buildCsv(
                ["投稿者", "部署", "コメント", "回答日時"],
                filtered.map((c) => [
                  c.author_name ?? "匿名",
                  c.department ?? "—",
                  c.comment,
                  c.answered_at ?? "",
                ]),
              );
              downloadCsv(`pulse_comments_${selectedPeriod ?? "all"}.csv`, csv);
              showToast("success", `${filtered.length}件をCSV出力しました`);
            }}
          >
            CSVダウンロード
          </button>
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
          <p className="pcmt__summary">
            {comments.length === 0
              ? "表示できるコメントはありません（未投稿、またはプライバシー保護のため少人数の集団は表示されません）。"
              : filtered.length === 0
                ? "条件に一致するコメントはありません。"
                : `${filtered.length} / ${comments.length} 件のコメント`}
          </p>
          <div className="pcmt__list">
            {filtered.map((c) => (
              <CommentCard key={c.response_id} c={c} />
            ))}
          </div>
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
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
        <span className={"pcmt__dept" + (c.department ? "" : " is-masked")}>
          {c.department ?? "—"}
        </span>
        {when && <span className="pcmt__when">{when}</span>}
      </div>
      <p className="pcmt__body">{c.comment}</p>
    </section>
  );
}

export default PulseCommentsPage;
