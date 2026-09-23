import { useEffect, useMemo } from "react";
import { useEmployeesStore, activeEmployees } from "../../store/useEmployeesStore";
import { useAiLevelsStore } from "../../store/useAiLevelsStore";
import { useUiStore } from "../../store/useUiStore";
import { useRevalidateOnFocus } from "../../lib/useRevalidateOnFocus";
import { employeeName, type EmployeeRow } from "../../lib/supabase";
import {
  AI_LEVELS,
  EMPLOYMENT_BUCKET_LABEL,
  employmentBucketOf,
  type CurrentAiLevel,
  type EmploymentBucket,
} from "../../lib/aiLevels";
import { AiLevelBadge } from "./AiLevelBadge";
import { AiLevelSubnav } from "./AiLevelSubnav";

/**
 * AI活用レベル ダッシュボード（#/ailevel・全ログインユーザー閲覧可）。
 * 全社分布 / L4+ statカード / 部門別 / 雇用区分別（別枠）/ L4+該当者リスト。
 * チャートは依存ライブラリ無しの手書き（pulse ダッシュボードの方式踏襲）。
 */

type LevelCounts = {
  /** index 0..6 = L1..L7 */
  byLevel: number[];
  uncertified: number;
  total: number;
};

function countLevels(
  rows: EmployeeRow[],
  levelOf: Map<string, CurrentAiLevel>,
): LevelCounts {
  const byLevel = Array.from({ length: 7 }, () => 0);
  let uncertified = 0;
  for (const e of rows) {
    const cur = levelOf.get(e.employee_number);
    if (cur) byLevel[cur.level - 1] += 1;
    else uncertified += 1;
  }
  return { byLevel, uncertified, total: rows.length };
}

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 1000) / 10}%`;
}

export function AiLevelDashboardPage() {
  const employees = useEmployeesStore((s) => s.employees);
  const empLoading = useEmployeesStore((s) => s.loading);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const levelOf = useAiLevelsStore((s) => s.levelByEmployee);
  const loaded = useAiLevelsStore((s) => s.loaded);
  const loading = useAiLevelsStore((s) => s.loading);
  const missing = useAiLevelsStore((s) => s.missing);
  const error = useAiLevelsStore((s) => s.error);
  const refreshLevels = useAiLevelsStore((s) => s.refresh);
  const navigate = useUiStore((s) => s.navigate);

  useEffect(() => {
    if (employees.length === 0) refreshEmployees();
    refreshLevels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useRevalidateOnFocus(() => {
    refreshEmployees({ silent: true });
    refreshLevels({ silent: true });
  });

  const active = useMemo(() => activeEmployees(employees), [employees]);

  const buckets = useMemo(() => {
    const map: Record<EmploymentBucket, EmployeeRow[]> = {
      employee: [],
      contractor: [],
      intern: [],
    };
    for (const e of active) map[employmentBucketOf(e.employment_type)].push(e);
    return map;
  }, [active]);

  const allCounts = useMemo(() => countLevels(active, levelOf), [active, levelOf]);
  const employeeCounts = useMemo(
    () => countLevels(buckets.employee, levelOf),
    [buckets, levelOf],
  );

  // 部門別分布（社員＋委託＋インターン全体・部署未設定は「部署未設定」）。
  const byDepartment = useMemo(() => {
    const groups = new Map<string, EmployeeRow[]>();
    for (const e of active) {
      const dept = e.department?.trim() || "部署未設定";
      const arr = groups.get(dept);
      if (arr) arr.push(e);
      else groups.set(dept, [e]);
    }
    return [...groups.entries()]
      .map(([dept, rows]) => ({ dept, counts: countLevels(rows, levelOf) }))
      .sort((a, b) => b.counts.total - a.counts.total);
  }, [active, levelOf]);

  // L4+ 該当者（社員 / 委託・インターン別枠）・レベル降順→部署順。
  const seniorLists = useMemo(() => {
    const pickL4Plus = (rows: EmployeeRow[]) =>
      rows
        .map((e) => ({ emp: e, cur: levelOf.get(e.employee_number) }))
        .filter((x): x is { emp: EmployeeRow; cur: CurrentAiLevel } => !!x.cur && x.cur.level >= 4)
        .sort(
          (a, b) =>
            b.cur.level - a.cur.level ||
            (a.emp.department ?? "").localeCompare(b.emp.department ?? "", "ja") ||
            a.emp.employee_number.localeCompare(b.emp.employee_number),
        );
    return {
      employee: pickL4Plus(buckets.employee),
      external: pickL4Plus([...buckets.contractor, ...buckets.intern]),
    };
  }, [buckets, levelOf]);

  const builderPlus = employeeCounts.byLevel.slice(3).reduce((a, b) => a + b, 0);
  const certifiedAll = allCounts.total - allCounts.uncertified;
  const maxCount = Math.max(1, ...allCounts.byLevel, allCounts.uncertified);

  const busy = (!loaded && loading) || (empLoading && employees.length === 0);

  return (
    <main className="page ail">
      <AiLevelSubnav active="dashboard" />
      <header className="page__header ail__header">
        <h1 className="page__title">AI活用レベル</h1>
        <p className="page__subtitle">
          全社員のAI活用レベル（L1 USER 〜 L7 GAME CHANGER）の認定状況。レベルは失効なし（上がるだけ）・個人レベルは全社オープンです。
        </p>
      </header>

      {busy && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}
      {loaded && !error && missing && (
        <p className="ail__notice">
          認定データがまだありません（未接続）。認定の付与が始まると、ここに分布が表示されます。
        </p>
      )}

      {!busy && !error && (
        <>
          {/* stat カード */}
          <section className="pdash__cards">
            <div className="pdash__stat is-accent">
              <div className="pdash__stat-label">BUILDER（L4）以上 — 社員</div>
              <div className="pdash__stat-value">{builderPlus}名</div>
              <div className="pdash__stat-sub">
                社員 {employeeCounts.total}名中 {pct(builderPlus, employeeCounts.total)}
                ・リーダー任用入口ライン
              </div>
            </div>
            <div className="pdash__stat">
              <div className="pdash__stat-label">認定済み（全体）</div>
              <div className="pdash__stat-value">{certifiedAll}名</div>
              <div className="pdash__stat-sub">
                対象 {allCounts.total}名中 {pct(certifiedAll, allCounts.total)}
              </div>
            </div>
            <div className="pdash__stat">
              <div className="pdash__stat-label">未認定</div>
              <div className="pdash__stat-value">{allCounts.uncertified}名</div>
              <div className="pdash__stat-sub">初回は仮認定→本認定の2段階</div>
            </div>
          </section>

          {/* 全社分布バー */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">全社分布（L1〜L7）</h2>
            <div className="ail__dist">
              {AI_LEVELS.map((d) => {
                const c = allCounts.byLevel[d.level - 1];
                return (
                  <div key={d.level} className="ail__distRow">
                    <span className="ail__distLabel">
                      <span className="ail__distLv" style={{ color: d.color.main }}>
                        L{d.level}
                      </span>
                      <span className="ail__distCode">{d.code}</span>
                      <span className="ail__distSub">{d.subcopy}</span>
                    </span>
                    <div className="ail__distTrack">
                      <div
                        className="ail__distBar"
                        style={{
                          width: `${(c / maxCount) * 100}%`,
                          background: d.color.main,
                        }}
                      />
                    </div>
                    <span className="ail__distCount">{c}</span>
                  </div>
                );
              })}
              <div className="ail__distRow ail__distRow--uncertified">
                <span className="ail__distLabel">
                  <span className="ail__distLv">—</span>
                  <span className="ail__distCode">未認定</span>
                </span>
                <div className="ail__distTrack">
                  <div
                    className="ail__distBar ail__distBar--uncertified"
                    style={{ width: `${(allCounts.uncertified / maxCount) * 100}%` }}
                  />
                </div>
                <span className="ail__distCount">{allCounts.uncertified}</span>
              </div>
            </div>
          </section>

          {/* 部門別分布 */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">部門別分布</h2>
            {byDepartment.length === 0 ? (
              <p className="pdash__muted">データなし</p>
            ) : (
              <div className="ail__depts">
                {byDepartment.map(({ dept, counts }) => {
                  const certified = counts.total - counts.uncertified;
                  return (
                    <div key={dept} className="ail__deptRow">
                      <span className="ail__deptName" title={dept}>
                        {dept}
                      </span>
                      <div className="ail__deptTrack" title={`認定 ${certified} / ${counts.total}名`}>
                        {AI_LEVELS.map((d) => {
                          const c = counts.byLevel[d.level - 1];
                          if (c === 0) return null;
                          return (
                            <div
                              key={d.level}
                              className="ail__deptSeg"
                              style={{
                                flexGrow: c,
                                background: d.color.main,
                              }}
                              title={`L${d.level} ${d.code}: ${c}名`}
                            />
                          );
                        })}
                        {counts.uncertified > 0 && (
                          <div
                            className="ail__deptSeg ail__deptSeg--uncertified"
                            style={{ flexGrow: counts.uncertified }}
                            title={`未認定: ${counts.uncertified}名`}
                          />
                        )}
                      </div>
                      <span className="ail__deptCount">
                        {certified}/{counts.total}
                      </span>
                    </div>
                  );
                })}
                <p className="ail__note">
                  帯はレベル別の人数構成（グレー＝未認定）。数字は「認定済み/在籍」。
                </p>
              </div>
            )}
          </section>

          {/* 雇用区分別（別枠集計） */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">雇用区分別（別枠集計）</h2>
            <p className="ail__note">
              業務委託・インターンも分布対象ですが、任用接続（L4=リーダー任用入口／L5=TM入口／L6=DM入口）は社員のみに適用されます。
            </p>
            <div className="ail__bucketGrid">
              {(Object.keys(EMPLOYMENT_BUCKET_LABEL) as EmploymentBucket[]).map((bucket) => {
                const counts = countLevels(buckets[bucket], levelOf);
                const bMax = Math.max(1, ...counts.byLevel, counts.uncertified);
                return (
                  <div key={bucket} className="ail__bucket">
                    <h3 className="ail__bucketTitle">
                      {EMPLOYMENT_BUCKET_LABEL[bucket]}
                      <span className="ail__bucketTotal">{counts.total}名</span>
                    </h3>
                    {counts.total === 0 ? (
                      <p className="pdash__muted">対象者なし</p>
                    ) : (
                      <div className="ail__dist ail__dist--compact">
                        {AI_LEVELS.map((d) => {
                          const c = counts.byLevel[d.level - 1];
                          return (
                            <div key={d.level} className="ail__distRow">
                              <span className="ail__distLabel ail__distLabel--compact">
                                <span className="ail__distLv" style={{ color: d.color.main }}>
                                  L{d.level}
                                </span>
                                <span className="ail__distCode">{d.code}</span>
                              </span>
                              <div className="ail__distTrack">
                                <div
                                  className="ail__distBar"
                                  style={{
                                    width: `${(c / bMax) * 100}%`,
                                    background: d.color.main,
                                  }}
                                />
                              </div>
                              <span className="ail__distCount">{c}</span>
                            </div>
                          );
                        })}
                        <div className="ail__distRow ail__distRow--uncertified">
                          <span className="ail__distLabel ail__distLabel--compact">
                            <span className="ail__distLv">—</span>
                            <span className="ail__distCode">未認定</span>
                          </span>
                          <div className="ail__distTrack">
                            <div
                              className="ail__distBar ail__distBar--uncertified"
                              style={{ width: `${(counts.uncertified / bMax) * 100}%` }}
                            />
                          </div>
                          <span className="ail__distCount">{counts.uncertified}</span>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {/* L4+ 該当者リスト */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">BUILDER（L4）以上の認定者</h2>
            <h3 className="ail__listGroupTitle">
              社員 <span className="ail__note">— 任用接続の対象（L4=リーダー任用入口／L5=TM入口／L6=DM入口・役員はL6以上／L7=実績指標）</span>
            </h3>
            {seniorLists.employee.length === 0 ? (
              <p className="pdash__muted">L4以上の認定者はまだいません。</p>
            ) : (
              <ul className="ail__people">
                {seniorLists.employee.map(({ emp, cur }) => (
                  <li key={emp.employee_number}>
                    <button
                      className="ail__person"
                      onClick={() => navigate({ name: "employee", num: emp.employee_number })}
                      title="クリックでメンバー詳細へ"
                    >
                      <AiLevelBadge level={cur.level} kind={cur.kind} size="md" />
                      <span className="ail__personName">{employeeName(emp)}</span>
                      <span className="ail__personDept">{emp.department ?? "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="ail__listGroupTitle">
              業務委託・インターン <span className="ail__note">— 別枠（任用接続の対象外）</span>
            </h3>
            {seniorLists.external.length === 0 ? (
              <p className="pdash__muted">L4以上の認定者はまだいません。</p>
            ) : (
              <ul className="ail__people">
                {seniorLists.external.map(({ emp, cur }) => (
                  <li key={emp.employee_number}>
                    <button
                      className="ail__person"
                      onClick={() => navigate({ name: "employee", num: emp.employee_number })}
                      title="クリックでメンバー詳細へ"
                    >
                      <AiLevelBadge level={cur.level} kind={cur.kind} size="md" />
                      <span className="ail__personName">{employeeName(emp)}</span>
                      <span className="ail__personDept">{emp.department ?? "—"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 7段階の定義（リファレンス） */}
          <section className="pdash__panel">
            <h2 className="pdash__h2">7段階の定義</h2>
            <div className="ail__defs">
              {AI_LEVELS.map((d) => (
                <div key={d.level} className="ail__def">
                  <AiLevelBadge level={d.level} size="md" />
                  <div className="ail__defBody">
                    <span className="ail__defSub">{d.subcopy}</span>
                    <span className="ail__defText">{d.definition}</span>
                    {d.appointment && (
                      <span className="ail__defAppointment">任用接続: {d.appointment}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

export default AiLevelDashboardPage;
