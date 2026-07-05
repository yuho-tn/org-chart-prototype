import { useEffect, useMemo, useState } from "react";
import { useMissionsStore, periodLabel } from "../../store/useMissionsStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { useProfilesStore } from "../../store/useProfilesStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import { employeeName, type EmployeeRow, type PeriodCode } from "../../lib/supabase";
import {
  isEvaluatorOfClient,
  deadlineInfo,
  stageIndex,
  type MissionSheetRow,
  type MissionTemplateRow,
} from "../../lib/mission";
import { ConfirmDialog } from "../ConfirmDialog";
import { StageBadge, DeadlineBanner } from "./shared";

type MissionTab = "my" | "targets" | "dashboard" | "issue";

/**
 * #/missions — ミッションシートのホーム。
 *   マイシート: 自分のシートカード（締切バナー付き）
 *   評価対象: 評価者（同一部署・上位レベル or evaluate_any）のみ表示
 *   ダッシュボード / 発行: mission.manage 権限のみ
 * 権限判定はクライアント側ミラー — 真の強制は RLS / RPC 側。
 */
export function MissionsPage() {
  const templates = useMissionsStore((s) => s.templates);
  const sheets = useMissionsStore((s) => s.sheets);
  const periods = useMissionsStore((s) => s.periods);
  const loaded = useMissionsStore((s) => s.loaded);
  const loading = useMissionsStore((s) => s.loading);
  const error = useMissionsStore((s) => s.error);
  const refresh = useMissionsStore((s) => s.refresh);

  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const positionLevels = useProfilesStore((s) => s.positionLevels);
  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const can = useProfilesStore((s) => s.can);
  const currentEmployeeNumber = useProfilesStore((s) => s.currentEmployeeNumber);

  const navigate = useUiStore((s) => s.navigate);

  useEffect(() => {
    refresh();
    if (employees.length === 0) refreshEmployees();
    if (!profilesLoaded) refreshProfiles();
    // 表示時 fetch のみ（低頻度データのためポーリングなし）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const me = currentEmployeeNumber();
  const meEmp = useMemo(
    () => employees.find((e) => e.employee_number === me) ?? null,
    [employees, me],
  );
  const canManage = can("mission", "manage");
  const evaluateAny = can("mission", "evaluate_any");

  const employeesByNumber = useMemo(() => {
    const map: Record<string, EmployeeRow> = {};
    for (const e of employees) map[e.employee_number] = e;
    return map;
  }, [employees]);

  const templatesById = useMemo(() => {
    const map: Record<string, MissionTemplateRow> = {};
    for (const t of templates) map[t.id] = t;
    return map;
  }, [templates]);

  /** period → sort_order（新しい期を先頭に並べるため）。 */
  const periodSort = useMemo(() => {
    const map: Record<string, number> = {};
    periods.forEach((p) => {
      map[p.code] = p.sort_order;
    });
    return map;
  }, [periods]);

  const mySheets = useMemo(
    () =>
      sheets
        .filter((s) => me && s.employee_number === me)
        .sort((a, b) => (periodSort[b.period] ?? 0) - (periodSort[a.period] ?? 0)),
    [sheets, me, periodSort],
  );

  /** 評価対象シート: 自分以外で、評価者判定 or evaluate_any が真のもの。 */
  const targetSheets = useMemo(
    () =>
      sheets
        .filter((s) => s.employee_number !== me)
        .filter((s) => {
          if (evaluateAny) return true;
          const emp = employeesByNumber[s.employee_number];
          return isEvaluatorOfClient(meEmp, emp, positionLevels);
        })
        .sort(
          (a, b) =>
            (periodSort[b.period] ?? 0) - (periodSort[a.period] ?? 0) ||
            a.employee_number.localeCompare(b.employee_number),
        ),
    [sheets, me, evaluateAny, employeesByNumber, meEmp, positionLevels, periodSort],
  );

  const showTargets = evaluateAny || targetSheets.length > 0;

  const [tab, setTab] = useState<MissionTab>("my");
  const effectiveTab: MissionTab =
    (tab === "targets" && !showTargets) ||
    ((tab === "dashboard" || tab === "issue") && !canManage)
      ? "my"
      : tab;

  const tabs: { id: MissionTab; label: string }[] = [
    { id: "my", label: "マイシート" },
    ...(showTargets ? [{ id: "targets" as const, label: "評価対象" }] : []),
    ...(canManage
      ? [
          { id: "dashboard" as const, label: "ダッシュボード" },
          { id: "issue" as const, label: "発行" },
        ]
      : []),
  ];

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">ミッションシート</h1>
          <p className="page__subtitle">
            期初の目標設定から上長確認・査定までを1枚のシートで管理します。
          </p>
        </div>
        {canManage && (
          <div className="page__actions">
            <button
              className="btn btn--ghost"
              onClick={() => navigate({ name: "mission_templates" })}
            >
              🗒 テンプレート管理
            </button>
          </div>
        )}
      </div>

      {error && <p className="versions__error">{error}</p>}

      <div className="payroll-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={effectiveTab === t.id}
            className={`payroll-tab ${effectiveTab === t.id ? "is-active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading && !loaded && <p className="empdetail__empty">読み込み中…</p>}

      {effectiveTab === "my" && (
        <MySheetsTab
          sheets={mySheets}
          templatesById={templatesById}
          periods={periods}
          onOpen={(id) => navigate({ name: "mission_sheet", id })}
        />
      )}

      {effectiveTab === "targets" && (
        <TargetsTab
          sheets={targetSheets}
          templatesById={templatesById}
          employeesByNumber={employeesByNumber}
          periods={periods}
          onOpen={(id) => navigate({ name: "mission_sheet", id })}
        />
      )}

      {effectiveTab === "dashboard" && canManage && (
        <DashboardTab
          sheets={sheets}
          templatesById={templatesById}
          employeesByNumber={employeesByNumber}
          periods={periods}
          periodSort={periodSort}
          onOpen={(id) => navigate({ name: "mission_sheet", id })}
        />
      )}

      {effectiveTab === "issue" && canManage && <IssueTab />}
    </main>
  );
}

// ── マイシート ────────────────────────────────────────────────────────

function MySheetsTab({
  sheets,
  templatesById,
  periods,
  onOpen,
}: {
  sheets: MissionSheetRow[];
  templatesById: Record<string, MissionTemplateRow>;
  periods: ReturnType<typeof useMissionsStore.getState>["periods"];
  onOpen: (id: string) => void;
}) {
  if (sheets.length === 0) {
    return (
      <p className="empdetail__empty">
        あなた宛のミッションシートはまだ発行されていません。
      </p>
    );
  }
  return (
    <div className="mission__cards">
      {sheets.map((sheet) => {
        const tpl = templatesById[sheet.template_id];
        return (
          <div key={sheet.id} className="mission__card">
            <div className="mission__cardHead">
              <span className="mission__cardPeriod">
                {periodLabel(sheet.period, periods)}
              </span>
              <StageBadge stage={sheet.stage} />
            </div>
            <div className="mission__cardTitle">{tpl?.title ?? "ミッションシート"}</div>
            <DeadlineBanner template={tpl} stage={sheet.stage} />
            <div className="mission__cardActions">
              <button className="btn btn--primary" onClick={() => onOpen(sheet.id)}>
                シートを開く
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── 評価対象 ──────────────────────────────────────────────────────────

function TargetsTab({
  sheets,
  templatesById,
  employeesByNumber,
  periods,
  onOpen,
}: {
  sheets: MissionSheetRow[];
  templatesById: Record<string, MissionTemplateRow>;
  employeesByNumber: Record<string, EmployeeRow>;
  periods: ReturnType<typeof useMissionsStore.getState>["periods"];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="emppage__tableWrap">
      <table className="empmgr__table emppage__table">
        <thead>
          <tr>
            <th>氏名</th>
            <th>部署</th>
            <th style={{ width: 110 }}>期</th>
            <th style={{ width: 130 }}>ステージ</th>
            <th style={{ width: 130 }}>最終更新</th>
            <th style={{ width: 110 }} />
          </tr>
        </thead>
        <tbody>
          {sheets.length === 0 && (
            <tr>
              <td colSpan={6} className="usermgr__empty">
                評価対象のシートはありません。
              </td>
            </tr>
          )}
          {sheets.map((sheet) => {
            const emp = employeesByNumber[sheet.employee_number];
            const tpl = templatesById[sheet.template_id];
            // 未提出（発行済のまま）/ 提出済み未確認 をハイライト
            const highlight =
              sheet.stage === "issued"
                ? "mission__row--pending"
                : sheet.stage === "goal_submitted"
                  ? "mission__row--action"
                  : "";
            const dl = tpl ? deadlineInfo(tpl, sheet.stage) : null;
            return (
              <tr key={sheet.id} className={highlight}>
                <td>{emp ? employeeName(emp) : sheet.employee_number}</td>
                <td>{emp?.department ?? "—"}</td>
                <td>{periodLabel(sheet.period, periods)}</td>
                <td>
                  <StageBadge stage={sheet.stage} />
                  {sheet.stage === "goal_submitted" && (
                    <span className="mission__hintNote">要確認</span>
                  )}
                  {dl?.overdue && (
                    <span className="mission__hintNote mission__hintNote--overdue">
                      期限超過
                    </span>
                  )}
                </td>
                <td>{sheet.updated_at?.slice(0, 10) ?? "—"}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn btn--ghost btn--xs" onClick={() => onOpen(sheet.id)}>
                    確認する
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── ダッシュボード（manage） ─────────────────────────────────────────

function DashboardTab({
  sheets,
  templatesById,
  employeesByNumber,
  periods,
  periodSort,
  onOpen,
}: {
  sheets: MissionSheetRow[];
  templatesById: Record<string, MissionTemplateRow>;
  employeesByNumber: Record<string, EmployeeRow>;
  periods: ReturnType<typeof useMissionsStore.getState>["periods"];
  periodSort: Record<string, number>;
  onOpen: (id: string) => void;
}) {
  const periodsWithSheets = useMemo(() => {
    const set = new Set(sheets.map((s) => s.period));
    return [...set].sort((a, b) => (periodSort[b] ?? 0) - (periodSort[a] ?? 0));
  }, [sheets, periodSort]);

  const [period, setPeriod] = useState<string>("");
  const effectivePeriod = period || periodsWithSheets[0] || "";

  const rows = useMemo(
    () =>
      sheets
        .filter((s) => s.period === effectivePeriod)
        .sort((a, b) => {
          const ea = employeesByNumber[a.employee_number];
          const eb = employeesByNumber[b.employee_number];
          return (
            (ea?.department ?? "").localeCompare(eb?.department ?? "", "ja") ||
            a.employee_number.localeCompare(b.employee_number)
          );
        }),
    [sheets, effectivePeriod, employeesByNumber],
  );

  /** 部署別集計: 提出率 =「本人提出済（goal_submitted）以上」の割合。 */
  const deptStats = useMemo(() => {
    const map = new Map<string, { total: number; submitted: number; confirmed: number }>();
    for (const s of rows) {
      const dept = employeesByNumber[s.employee_number]?.department ?? "（部署未設定）";
      const cur = map.get(dept) ?? { total: 0, submitted: 0, confirmed: 0 };
      cur.total += 1;
      if (stageIndex(s.stage) >= stageIndex("goal_submitted")) cur.submitted += 1;
      if (stageIndex(s.stage) >= stageIndex("goal_confirmed")) cur.confirmed += 1;
      map.set(dept, cur);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "ja"));
  }, [rows, employeesByNumber]);

  if (periodsWithSheets.length === 0) {
    return <p className="empdetail__empty">発行済みのシートがまだありません。</p>;
  }

  return (
    <>
      <div className="mission__toolbar">
        <label className="mission__toolbarLabel">
          期:
          <select
            className="field__input field__input--xs"
            value={effectivePeriod}
            onChange={(e) => setPeriod(e.target.value)}
          >
            {periodsWithSheets.map((p) => (
              <option key={p} value={p}>
                {periodLabel(p as PeriodCode, periods)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mission__deptstats">
        {deptStats.map(([dept, st]) => (
          <div key={dept} className="mission__deptstat">
            <div className="mission__deptstatName">{dept}</div>
            <div className="mission__deptstatNums">
              提出 {st.submitted}/{st.total}（{Math.round((st.submitted / st.total) * 100)}%）
              ・確定 {st.confirmed}/{st.total}
            </div>
            <div className="mission__deptstatBar">
              <span
                className="mission__deptstatFill"
                style={{ width: `${(st.submitted / st.total) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th>氏名</th>
              <th>部署</th>
              <th>役職</th>
              <th style={{ width: 130 }}>ステージ</th>
              <th style={{ width: 150 }}>締切</th>
              <th style={{ width: 100 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((sheet) => {
              const emp = employeesByNumber[sheet.employee_number];
              const tpl = templatesById[sheet.template_id];
              const dl = tpl ? deadlineInfo(tpl, sheet.stage) : null;
              return (
                <tr key={sheet.id} className={dl?.overdue ? "mission__row--overdue" : ""}>
                  <td>{emp ? employeeName(emp) : sheet.employee_number}</td>
                  <td>{emp?.department ?? "—"}</td>
                  <td>{emp?.position_title ?? "—"}</td>
                  <td>
                    <StageBadge stage={sheet.stage} />
                  </td>
                  <td>
                    {dl ? (
                      dl.overdue ? (
                        <span className="mission__dlText mission__dlText--overdue">
                          {dl.date}（{Math.abs(dl.daysLeft)}日超過）
                        </span>
                      ) : (
                        <span className="mission__dlText">
                          {dl.date}
                          {dl.daysLeft === 0 ? "（本日締切）" : `（あと${dl.daysLeft}日）`}
                        </span>
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => onOpen(sheet.id)}
                    >
                      開く
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── 発行（manage） ────────────────────────────────────────────────────

function IssueTab() {
  const templates = useMissionsStore((s) => s.templates);
  const sheets = useMissionsStore((s) => s.sheets);
  const periods = useMissionsStore((s) => s.periods);
  const issueSheets = useMissionsStore((s) => s.issueSheets);
  const employees = useEmployeesStore((s) => s.employees);
  const setToast = useOrgStore((s) => s.setToast);

  const published = useMemo(
    () => templates.filter((t) => t.status === "published"),
    [templates],
  );

  const [templateId, setTemplateId] = useState("");
  const effectiveTemplateId = templateId || published[0]?.id || "";
  const template = published.find((t) => t.id === effectiveTemplateId) ?? null;

  /** 既定フィルタ: 在籍中（left_at IS NULL）かつ 雇用形態に「業務委託」を含まない。 */
  const [showExcluded, setShowExcluded] = useState(false);

  const isEligible = (e: EmployeeRow) =>
    !e.left_at && !(e.employment_type ?? "").includes("業務委託");

  const list = useMemo(() => {
    const base = showExcluded ? employees : employees.filter(isEligible);
    return [...base].sort(
      (a, b) =>
        (a.department ?? "").localeCompare(b.department ?? "", "ja") ||
        a.employee_number.localeCompare(b.employee_number),
    );
  }, [employees, showExcluded]);

  /** 選択中テンプレの期に既にシートがある人（発行済・チェック不可）。 */
  const issuedSet = useMemo(() => {
    if (!template) return new Set<string>();
    return new Set(
      sheets.filter((s) => s.period === template.period).map((s) => s.employee_number),
    );
  }, [sheets, template]);

  // チェック状態: 明示操作を上書きマップで持ち、既定は「対象フィルタ内かつ未発行=ON」。
  // テンプレ（=期）を切り替えたら選択をリセットするため、テンプレIDごとに持つ。
  const [overridesState, setOverridesState] = useState<{
    tplId: string;
    map: Record<string, boolean>;
  }>({ tplId: "", map: {} });
  const overrides =
    overridesState.tplId === effectiveTemplateId ? overridesState.map : {};
  const setOverride = (employeeNumber: string, checked: boolean) =>
    setOverridesState({
      tplId: effectiveTemplateId,
      map: { ...overrides, [employeeNumber]: checked },
    });

  const isChecked = (e: EmployeeRow) => {
    if (issuedSet.has(e.employee_number)) return false;
    return overrides[e.employee_number] ?? isEligible(e);
  };

  const selected = list.filter(isChecked);
  const [confirming, setConfirming] = useState(false);
  const [issuing, setIssuing] = useState(false);

  async function handleIssue() {
    if (!template) return;
    setIssuing(true);
    const res = await issueSheets(
      template.id,
      selected.map((e) => e.employee_number),
    );
    setIssuing(false);
    setConfirming(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "発行に失敗しました" });
      return;
    }
    setOverridesState({ tplId: "", map: {} });
    setToast({
      kind: "info",
      message: `${res.created ?? 0}名にシートを発行しました（発行済みはスキップ）`,
    });
  }

  if (published.length === 0) {
    return (
      <p className="empdetail__empty">
        公開済み（published）のテンプレートがありません。テンプレート管理から作成・公開してください。
      </p>
    );
  }

  return (
    <>
      <div className="mission__toolbar">
        <label className="mission__toolbarLabel">
          テンプレート:
          <select
            className="field__input"
            value={effectiveTemplateId}
            onChange={(e) => setTemplateId(e.target.value)}
          >
            {published.map((t) => (
              <option key={t.id} value={t.id}>
                {periodLabel(t.period, periods)}｜{t.title}
              </option>
            ))}
          </select>
        </label>
        <label className="payroll-checkbox">
          <input
            type="checkbox"
            checked={showExcluded}
            onChange={(e) => setShowExcluded(e.target.checked)}
          />
          業務委託・退職者も表示（既定は対象外）
        </label>
        <div className="mission__toolbarSpacer" />
        <button
          className="btn btn--primary"
          disabled={!template || selected.length === 0 || issuing}
          onClick={() => setConfirming(true)}
        >
          {selected.length}名に発行
        </button>
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th style={{ width: 44 }} />
              <th>氏名</th>
              <th>部署</th>
              <th>役職</th>
              <th style={{ width: 120 }}>雇用形態</th>
              <th style={{ width: 90 }}>状態</th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 && (
              <tr>
                <td colSpan={6} className="usermgr__empty">対象者がいません。</td>
              </tr>
            )}
            {list.map((e) => {
              const issued = issuedSet.has(e.employee_number);
              const excluded = !isEligible(e);
              return (
                <tr
                  key={e.employee_number}
                  className={issued ? "mission__row--issued" : excluded ? "is-inactive" : ""}
                >
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      disabled={issued}
                      checked={isChecked(e)}
                      onChange={(ev) => setOverride(e.employee_number, ev.target.checked)}
                    />
                  </td>
                  <td>{employeeName(e)}</td>
                  <td>{e.department ?? "—"}</td>
                  <td>{e.position_title ?? "—"}</td>
                  <td>{e.employment_type ?? "—"}</td>
                  <td>
                    {issued && <span className="mission__issuedBadge">発行済</span>}
                    {!issued && excluded && (
                      <span className="mission__hintNote">既定対象外</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirming && template && (
        <ConfirmDialog
          title="ミッションシートの発行"
          message={
            <>
              「{periodLabel(template.period, periods)}｜{template.title}」を{" "}
              <strong>{selected.length}名</strong> に発行します。
              既にシートがある人はスキップされます（冪等）。よろしいですか？
            </>
          }
          confirmLabel={issuing ? "発行中…" : "発行する"}
          onConfirm={handleIssue}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
