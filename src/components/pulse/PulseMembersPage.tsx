import { memo, useEffect, useMemo, useState } from "react";
import "./pulse-shared.css";
import "./members.css";
import "./alerts.css"; // .pcare__ （対応・面談ログ）を本ページのメンバー詳細でも再利用しているため
import { usePulseMembersStore } from "../../store/usePulseMembersStore";
import { useUiStore } from "../../store/useUiStore";
import { PulseSubnav } from "./PulseSubnav";
import { usePulseToast, PulseToast } from "./usePulseToast";
import { supabase } from "../../lib/supabase";
import {
  periodLabel,
  weatherForScore,
  memberTrend,
  isConsecutiveDecline,
  alertReasonSummary,
  ALERT_TYPE_LABEL,
  ACTION_STATE_LABEL,
  CARE_KIND_LABEL,
  type PulseMemberSummary,
  type PulseTrend,
  type PulsePersonHistoryRow,
  type PulseCareKind,
  type PulseCareLogRow,
  type PulsePersonAlertRow,
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
                // navigate は zustand セレクタで参照が安定しているため、行ごとに新規arrow関数を
                // 渡さず employee_number をそのまま渡す。MemberRow/MiniSpark の memo 化が効くようにする。
                <MemberRow key={m.employee_number} m={m} navigate={navigate} />
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

type NavigateFn = (route: { name: "pulse_member"; num: string }) => void;

/** 一覧行（P4-⑦: React.memo 化・行数が多いメンバー一覧の再描画コストを抑える）。 */
const MemberRow = memo(function MemberRow({
  m,
  navigate,
}: {
  m: PulseMemberSummary;
  navigate: NavigateFn;
}) {
  const latest = [...m.history].reverse().find((h) => h.overall != null);
  const weather = weatherForScore(latest?.overall);
  const trend = memberTrend(m.history);
  const decline = isConsecutiveDecline(m.history);
  return (
    <tr
      className="pmem__row"
      onClick={() => navigate({ name: "pulse_member", num: m.employee_number })}
    >
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
});

/** 一覧行内の小型スパークライン（履歴 overall 1..5）。React.memo 化：history参照が同じなら再描画しない。 */
const MiniSpark = memo(function MiniSpark({ history }: { history: { overall: number | null }[] }) {
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
});

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
    canCare,
    careLogs,
    personAlerts,
    careSaving,
    loadPerson,
    addCareLog,
    deleteCareLog,
  } = usePulseMembersStore();
  const navigate = useUiStore((s) => s.navigate);
  const [name, setName] = useState<string | null>(null);
  const { toast, showToast, clearToast } = usePulseToast();

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

          {canCare && (
            <CareTimeline
              employeeNumber={employeeNumber}
              careLogs={careLogs}
              personAlerts={personAlerts}
              saving={careSaving}
              onAdd={async (kind, note) => {
                const res = await addCareLog(employeeNumber, kind, note);
                showToast(res.ok ? "success" : "error", res.ok ? "対応ログを記録しました" : res.reason ?? "記録に失敗しました");
                return res.ok;
              }}
              onDelete={async (id) => {
                if (!window.confirm("この対応ログを削除しますか？")) return;
                const res = await deleteCareLog(employeeNumber, id);
                if (!res.ok) showToast("error", res.reason ?? "削除に失敗しました");
              }}
            />
          )}
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
    </main>
  );
}

// ── P4-③: 対応・面談ログ（アラート対応と時系列マージ） ──────────────

type TimelineItem =
  | { kind: "care"; at: string; care: PulseCareLogRow }
  | { kind: "alert"; at: string; alert: PulsePersonAlertRow };

function CareTimeline({
  employeeNumber,
  careLogs,
  personAlerts,
  saving,
  onAdd,
  onDelete,
}: {
  employeeNumber: string;
  careLogs: PulseCareLogRow[];
  personAlerts: PulsePersonAlertRow[];
  saving: boolean;
  onAdd: (kind: PulseCareKind, note: string) => Promise<boolean>;
  onDelete: (id: string) => void;
}) {
  const [kind, setKind] = useState<PulseCareKind>("interview");
  const [note, setNote] = useState("");

  const items: TimelineItem[] = [
    ...careLogs.map((c) => ({ kind: "care" as const, at: c.created_at, care: c })),
    ...personAlerts.map((a) => ({ kind: "alert" as const, at: a.created_at, alert: a })),
  ].sort((x, y) => (x.at < y.at ? 1 : -1));

  const submit = async () => {
    if (note.trim() === "") return;
    const ok = await onAdd(kind, note.trim());
    if (ok) setNote("");
  };

  return (
    <section className="pdash__panel" data-emp={employeeNumber}>
      <h2 className="pdash__h2">対応・面談ログ</h2>

      <div className="pcare__form">
        <select
          className="pcare__kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as PulseCareKind)}
        >
          {(Object.keys(CARE_KIND_LABEL) as PulseCareKind[]).map((k) => (
            <option key={k} value={k}>
              {CARE_KIND_LABEL[k]}
            </option>
          ))}
        </select>
        <textarea
          className="pcare__note"
          rows={2}
          placeholder="面談・声かけの内容を記録（アラート管理権限者のみ閲覧）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          className="pdash__btn pdash__btn--primary"
          disabled={saving || note.trim() === ""}
          onClick={submit}
        >
          {saving ? "記録中…" : "記録する"}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="pdash__muted">対応履歴はまだありません</p>
      ) : (
        <ul className="pcare__list">
          {items.map((it) =>
            it.kind === "care" ? (
              <li key={`c-${it.care.id}`} className="pcare__item pcare__item--care">
                <div className="pcare__meta">
                  <span className="pcare__badge">{CARE_KIND_LABEL[it.care.kind]}</span>
                  <span className="pcare__who">
                    {it.care.author_name ?? it.care.author_email}
                  </span>
                  <span className="pcare__at">{fmtDateTime(it.care.created_at)}</span>
                  <button
                    className="pcare__del"
                    title="削除"
                    onClick={() => onDelete(it.care.id)}
                  >
                    ×
                  </button>
                </div>
                <p className="pcare__body">{it.care.note}</p>
              </li>
            ) : (
              <li key={`a-${it.alert.alert_id}`} className="pcare__item pcare__item--alert">
                <div className="pcare__meta">
                  <span className="pcare__badge pcare__badge--alert">
                    アラート（{ALERT_TYPE_LABEL[it.alert.type]}）
                  </span>
                  <span className="pcare__who">{periodLabel(it.alert.period)}</span>
                  <span className="pcare__at">{fmtDateTime(it.alert.created_at)}</span>
                  <span
                    className={
                      "pcare__status" + (it.alert.status === "open" ? " is-open" : "")
                    }
                  >
                    {it.alert.status === "open" ? "対応中" : "クローズ"}
                  </span>
                </div>
                <p className="pcare__body">
                  {alertReasonSummary(it.alert.type, it.alert.reason)}
                  {it.alert.action && (
                    <span className="pcare__action">
                      ／対応: {ACTION_STATE_LABEL[it.alert.action.state]}
                      {it.alert.action.assignee_name && `（${it.alert.action.assignee_name}）`}
                      {it.alert.action.note && ` — ${it.alert.action.note}`}
                    </span>
                  )}
                </p>
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  );
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
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
