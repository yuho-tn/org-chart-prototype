import { useEffect, useMemo, useState } from "react";
import { usePulseMembersStore } from "../../store/usePulseMembersStore";
import { useUiStore } from "../../store/useUiStore";
import { PulseSubnav } from "./PulseSubnav";
import { supabase } from "../../lib/supabase";
import {
  periodLabel,
  weatherForScore,
  memberTrend,
  isConsecutiveDecline,
  type PulseMemberSummary,
  type PulseTrend,
  type PulsePersonHistoryRow,
} from "../../lib/pulse";

/**
 * P4-①: パルス メンバー一覧（#/pulse/members・実名閲覧権限者のみ）。
 * 各メンバーの最新天気・直近トレンド・3ヶ月連続下降フラグを一覧表示し、
 * 行クリックで個人詳細（#/pulse/members/:emp）へ。
 */
export function PulseMembersPage() {
  const { loaded, loading, error, members, loadMembers } = usePulseMembersStore();
  const navigate = useUiStore((s) => s.navigate);
  const [q, setQ] = useState("");
  const [careOnly, setCareOnly] = useState(false);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return members.filter((m) => {
      if (careOnly && !isConsecutiveDecline(m.history)) return false;
      if (!needle) return true;
      return (
        m.name.toLowerCase().includes(needle) ||
        (m.department ?? "").toLowerCase().includes(needle) ||
        m.employee_number.includes(needle)
      );
    });
  }, [members, q, careOnly]);

  const careCount = useMemo(
    () => members.filter((m) => isConsecutiveDecline(m.history)).length,
    [members],
  );

  return (
    <main className="page pdash pmem">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">メンバー別回答推移</h1>
          <p className="pdash__sub">
            実名閲覧権限者のみ。最新の天気・直近トレンド・連続下降サインを表示します
          </p>
        </div>
        <div className="pdash__controls">
          <input
            className="pmem__search"
            type="search"
            placeholder="氏名・部署で検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="pmem__careonly">
            <input
              type="checkbox"
              checked={careOnly}
              onChange={(e) => setCareOnly(e.target.checked)}
            />
            要ケアのみ{careCount > 0 ? `（${careCount}）` : ""}
          </label>
        </div>
      </header>

      <PulseSubnav active="members" />

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && (
        <section className="pdash__panel">
          <table className="pmem__table">
            <thead>
              <tr>
                <th>メンバー</th>
                <th>部署</th>
                <th>最新回答</th>
                <th>直近推移（〜6ヶ月）</th>
                <th>サイン</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <MemberRow
                  key={m.employee_number}
                  m={m}
                  onOpen={() => navigate({ name: "pulse_member", num: m.employee_number })}
                />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="pdash__muted" style={{ padding: 16 }}>
                    該当するメンバーがいません
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

const TREND_GLYPH: Record<PulseTrend, { glyph: string; label: string }> = {
  up: { glyph: "↗", label: "上昇" },
  down: { glyph: "↘", label: "下降" },
  flat: { glyph: "→", label: "横ばい" },
  none: { glyph: "—", label: "データ不足" },
};

function MemberRow({ m, onOpen }: { m: PulseMemberSummary; onOpen: () => void }) {
  const latest = [...m.history].reverse().find((h) => h.overall != null);
  const weather = weatherForScore(latest?.overall);
  const trend = memberTrend(m.history);
  const decline = isConsecutiveDecline(m.history);
  return (
    <tr className="pmem__row" onClick={onOpen}>
      <td>
        <span className="pmem__name">{m.name}</span>
        <span className="pmem__emp">{m.employee_number}</span>
      </td>
      <td className="pmem__dept">{m.department ?? "—"}</td>
      <td>
        {weather && latest ? (
          <span className="pmem__latest">
            <span aria-hidden>{weather.emoji}</span> {latest.overall?.toFixed(2)}
            <span className="pmem__period">{periodLabel(latest.period)}</span>
          </span>
        ) : (
          <span className="pdash__muted">未回答</span>
        )}
      </td>
      <td>
        <span className={`pmem__trend pmem__trend--${trend}`} title={TREND_GLYPH[trend].label}>
          {TREND_GLYPH[trend].glyph}
        </span>
        <MiniSpark history={m.history} />
      </td>
      <td>
        {decline && <span className="pmem__flag">⚠ 連続下降</span>}
      </td>
    </tr>
  );
}

/** 一覧行内の小型スパークライン（履歴 overall 1..5）。 */
function MiniSpark({ history }: { history: { overall: number | null }[] }) {
  const pts = history.filter((h) => h.overall != null) as { overall: number }[];
  if (pts.length < 2) return null;
  const W = 96, H = 24, pad = 3;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const ys = (v: number) => H - pad - ((v - 1) / 4) * (H - pad * 2);
  const line = pts.map((p, i) => `${xs(i)},${ys(p.overall)}`).join(" ");
  return (
    <svg className="pmem__spark" viewBox={`0 0 ${W} ${H}`} aria-hidden>
      <polyline points={line} fill="none" className="pmem__spark-line" />
    </svg>
  );
}

/**
 * P4-①: 個人詳細（#/pulse/members/:emp）。時系列チャート・カテゴリ推移・
 * コメント履歴を表示。対応ログ（アラート対応＋面談ログ）は P4-③ で統合。
 */
export function PulseMemberDetailPage({ employeeNumber }: { employeeNumber: string }) {
  const {
    members,
    personLoading,
    personError,
    personEmp,
    personHistory,
    loadPerson,
  } = usePulseMembersStore();
  const navigate = useUiStore((s) => s.navigate);
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    loadPerson(employeeNumber);
  }, [employeeNumber, loadPerson]);

  // 氏名解決: 一覧ロード済みならそこから、無ければ employees を1件読む。
  useEffect(() => {
    const inList = members.find((m) => m.employee_number === employeeNumber);
    if (inList) {
      setName(inList.name);
      return;
    }
    if (!supabase) return;
    let cancelled = false;
    supabase
      .from("employees")
      .select("display_name, full_name")
      .eq("employee_number", employeeNumber)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data) setName(data.display_name ?? data.full_name ?? employeeNumber);
      });
    return () => {
      cancelled = true;
    };
  }, [members, employeeNumber]);

  const history = personEmp === employeeNumber ? personHistory : [];
  const comments = history.filter((h) => h.comment && h.comment.trim() !== "");
  const latest = [...history].reverse().find((h) => h.overall != null);
  const weather = weatherForScore(latest?.overall);

  return (
    <main className="page pdash pmem">
      <header className="pdash__head">
        <div>
          <button className="pmem__back" onClick={() => navigate({ name: "pulse_members" })}>
            ← メンバー一覧
          </button>
          <h1 className="pdash__title">
            {name ?? employeeNumber}
            {weather && latest && (
              <span className="pmem__headweather">
                <span aria-hidden>{weather.emoji}</span> {latest.overall?.toFixed(2)}（
                {periodLabel(latest.period)}）
              </span>
            )}
          </h1>
          <p className="pdash__sub">全サイクルの回答推移とコメント履歴</p>
        </div>
      </header>

      <PulseSubnav active="members" />

      {personLoading && <p className="pdash__muted">読み込み中…</p>}
      {personError && <p className="pdash__error">{personError}</p>}

      {!personLoading && !personError && (
        <>
          <section className="pdash__panel">
            <h2 className="pdash__h2">総合スコアの推移</h2>
            <PersonTrend history={history} />
          </section>

          <section className="pdash__panel">
            <h2 className="pdash__h2">カテゴリ別の推移</h2>
            <CategoryHistory history={history} />
          </section>

          <section className="pdash__panel">
            <h2 className="pdash__h2">コメント履歴</h2>
            {comments.length === 0 ? (
              <p className="pdash__muted">コメントはまだありません</p>
            ) : (
              <ul className="pmem__comments">
                {[...comments].reverse().map((h) => (
                  <li key={h.cycle_id} className="pmem__comment">
                    <span className="pmem__comment-period">{periodLabel(h.period)}</span>
                    <p className="pmem__comment-body">{h.comment}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

/** 個人の総合スコア推移チャート（ダッシュボード Trend と同型・依存なし）。 */
function PersonTrend({ history }: { history: PulsePersonHistoryRow[] }) {
  const pts = history.filter((h) => h.overall != null) as (PulsePersonHistoryRow & {
    overall: number;
  })[];
  if (pts.length === 0) return <p className="pdash__muted">回答がまだありません</p>;
  if (pts.length === 1) {
    return (
      <p className="pdash__muted">
        {periodLabel(pts[0].period)}：<strong>{pts[0].overall.toFixed(2)}</strong>
        （推移は2期以上で表示）
      </p>
    );
  }
  const W = 480, H = 140, pad = 24;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (pts.length - 1);
  const ys = (v: number) => H - pad - ((v - 1) / 4) * (H - pad * 2);
  const line = pts.map((p, i) => `${xs(i)},${ys(p.overall)}`).join(" ");
  return (
    <svg className="pdash__spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {[1, 2, 3, 4, 5].map((g) => (
        <line key={g} x1={pad} x2={W - pad} y1={ys(g)} y2={ys(g)} className="pdash__grid" />
      ))}
      <polyline points={line} className="pdash__spark-line" fill="none" />
      {pts.map((p, i) => (
        <g key={p.period}>
          <circle cx={xs(i)} cy={ys(p.overall)} r={4} className="pdash__spark-dot" />
          <text x={xs(i)} y={H - 6} className="pdash__spark-x" textAnchor="middle">
            {p.period.slice(2)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** カテゴリ別スコアの期別テーブル（行=カテゴリ・列=期）。 */
function CategoryHistory({ history }: { history: PulsePersonHistoryRow[] }) {
  const cats = Array.from(
    new Set(history.flatMap((h) => Object.keys(h.by_category ?? {}))),
  );
  if (cats.length === 0 || history.length === 0) {
    return <p className="pdash__muted">データなし</p>;
  }
  return (
    <div className="pmem__cattable-wrap">
      <table className="pmem__cattable">
        <thead>
          <tr>
            <th>カテゴリ</th>
            {history.map((h) => (
              <th key={h.cycle_id}>{h.period.slice(2)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cats.map((cat) => (
            <tr key={cat}>
              <td>{cat}</td>
              {history.map((h) => {
                const v = h.by_category?.[cat];
                const w = weatherForScore(v);
                return (
                  <td key={h.cycle_id}>
                    {v != null ? (
                      <span title={v.toFixed(2)}>
                        <span aria-hidden>{w?.emoji}</span> {v.toFixed(1)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default PulseMembersPage;
