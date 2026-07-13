import { useEffect, useMemo, useState } from "react";
import { useEmployeesStore, isCasualEmployment } from "../store/useEmployeesStore";
import { useAuthStore, isOrgPowerUser } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import { useProfilesStore } from "../store/useProfilesStore";
import { useAiLevelsStore } from "../store/useAiLevelsStore";
import { AiLevelBadge } from "./ailevel/AiLevelBadge";
import { useUiStore } from "../store/useUiStore";
import { employeeName, type EmployeeRow } from "../lib/supabase";
import { avatarPathOf } from "../lib/profile";
import { normalizeMbti, MBTI_BY_CODE, MBTI_GROUP_COLOR } from "../lib/mbti";
import { STRENGTH_BY_ID, STRENGTH_DOMAIN_COLOR, normalizeStrengthIds } from "../lib/strengths";
import { useRevalidateOnFocus } from "../lib/useRevalidateOnFocus";
import type { ImportSummary } from "../store/useEmployeesStore";

const PAGE_SIZE = 50;

function uniqueSorted(values: (string | null)[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (v && v.trim()) set.add(v);
  }
  return [...set].sort((a, b) => a.localeCompare(b, "ja"));
}

const EMPTY_DRAFT: Partial<EmployeeRow> & { employee_number: string } = {
  employee_number: "",
  full_name: "",
  display_name: "",
  email: "",
  employment_type: "",
  department: "",
  position_title: "",
  hired_at: null,
  left_at: null,
};

/**
 * Dedicated employees page (not a modal). Shows the full roster with
 * pagination, search, retired-toggle, inline edit / delete, and the CSV
 * importer (URL or file). Routed via useUiStore.route === "employees"
 * and the URL hash #/employees so reload + back/forward work correctly.
 */
export function EmployeesPage() {
  const employees = useEmployeesStore((s) => s.employees);
  const loading = useEmployeesStore((s) => s.loading);
  const error = useEmployeesStore((s) => s.error);
  const refresh = useEmployeesStore((s) => s.refresh);
  const upsert = useEmployeesStore((s) => s.upsert);
  const removeOne = useEmployeesStore((s) => s.remove);
  const importCsv = useEmployeesStore((s) => s.importCsv);
  const importFromSheetUrl = useEmployeesStore((s) => s.importFromSheetUrl);
  const sheetCsvUrl = useEmployeesStore((s) => s.sheetCsvUrl);
  const setSheetCsvUrl = useEmployeesStore((s) => s.setSheetCsvUrl);
  const currentUser = useAuthStore((s) => s.currentUser);
  const setToast = useOrgStore((s) => s.setToast);
  const navigate = useUiStore((s) => s.navigate);

  // P1: プロフィール（アバター・あだ名）— ギャラリービューと詳細リンク用
  const profiles = useProfilesStore((s) => s.profilesByNumber);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const ensurePhotoUrls = useProfilesStore((s) => s.ensurePhotoUrls);
  const photoUrls = useProfilesStore((s) => s.photoUrls);

  // AI活用レベル — ギャラリーの称号小バッジ用（未認定は非表示）
  const aiLevelOf = useAiLevelsStore((s) => s.levelByEmployee);
  const refreshAiLevels = useAiLevelsStore((s) => s.refresh);

  // Full editors (master / privileged_admin / admin) can manage the
  // employees master incl. CSV import / add / edit / delete. Regular
  // editors and viewers are read-only.
  const isMaster = isOrgPowerUser(currentUser?.role);

  const [filter, setFilter] = useState("");
  // 一覧（テーブル）とギャラリー（写真カード）の切替
  const [viewMode, setViewMode] = useState<"list" | "gallery">("list");
  // Retirement state filter: 在籍 (default) / 退職 / 全て
  const [retirementMode, setRetirementMode] = useState<"active" | "retired" | "all">("active");
  const [empTypeFilter, setEmpTypeFilter] = useState<string>("");
  const [deptFilter, setDeptFilter] = useState<string>("");
  const [positionFilter, setPositionFilter] = useState<string>("");
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<EmployeeRow> & { employee_number: string }>(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] = useState<EmployeeRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [urlDraft, setUrlDraft] = useState(sheetCsvUrl);
  const [showImporter, setShowImporter] = useState(false);

  useEffect(() => {
    refresh();
    refreshProfiles();
    refreshAiLevels();
  }, [refresh, refreshProfiles, refreshAiLevels]);

  // P0-1: タブ復帰・フォーカス時に裏で再検証（初回ロードのスタックや
  // 長時間放置後の古いデータを自動回復。silent なのでスピナーは出ない）
  useRevalidateOnFocus(() => {
    refresh({ silent: true });
    refreshProfiles({ silent: true });
    refreshAiLevels({ silent: true });
  });

  useEffect(() => {
    setUrlDraft(sheetCsvUrl);
  }, [sheetCsvUrl]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Distinct values for the dropdown filters. Build once per employees list.
  const distinctEmpTypes = useMemo(
    () => uniqueSorted(employees.map((e) => e.employment_type)),
    [employees],
  );
  const distinctDepts = useMemo(
    () => uniqueSorted(employees.map((e) => e.department)),
    [employees],
  );
  const distinctPositions = useMemo(
    () => uniqueSorted(employees.map((e) => e.position_title)),
    [employees],
  );

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return employees
      .filter((e) => {
        // Retirement state
        const isRetired = !!e.left_at && e.left_at <= today;
        if (retirementMode === "active" && isRetired) return false;
        if (retirementMode === "retired" && !isRetired) return false;
        // Dropdown filters
        if (empTypeFilter && e.employment_type !== empTypeFilter) return false;
        if (deptFilter && e.department !== deptFilter) return false;
        if (positionFilter && e.position_title !== positionFilter) return false;
        // Free-text search
        if (!q) return true;
        const blob = [
          e.employee_number,
          e.full_name,
          e.display_name,
          e.email,
          e.department,
          e.position_title,
          e.employment_type,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return blob.includes(q);
      })
      .sort((a, b) => a.employee_number.localeCompare(b.employee_number));
  }, [employees, filter, retirementMode, empTypeFilter, deptFilter, positionFilter, today]);

  // In-roster headcount split by employment-type buckets the user
  // specifically wants visible at a glance.
  const headcounts = useMemo(() => {
    const active = employees.filter((e) => !e.left_at || e.left_at > today);
    const seishain = active.filter(
      (e) => e.employment_type === "正社員",
    ).length;
    const limited = active.filter(
      (e) => e.employment_type === "限定正社員",
    ).length;
    const casual = active.filter((e) => isCasualEmployment(e.employment_type)).length;
    return { total: active.length, seishain, limited, casual };
  }, [employees, today]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // If the filter changes and the current page is out of range, snap back.
  useEffect(() => {
    if (page > totalPages) setPage(1);
  }, [page, totalPages]);

  const pageStart = (page - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  // ギャラリー表示中のページのアバター signed URL をまとめて確保
  useEffect(() => {
    if (viewMode !== "gallery") return;
    const paths = pageRows
      .map((e) => avatarPathOf(profiles[e.employee_number]))
      .filter((p): p is string => !!p);
    if (paths.length > 0) ensurePhotoUrls(paths);
  }, [viewMode, pageRows, profiles, ensurePhotoUrls]);

  function openDetail(emp: EmployeeRow) {
    navigate({ name: "employee", num: emp.employee_number });
  }

  function startEdit(emp: EmployeeRow) {
    setEditing(emp.employee_number);
    setDraft({ ...emp });
  }

  function startNew() {
    setEditing("__new__");
    setDraft(EMPTY_DRAFT);
  }

  function cancelEdit() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
  }

  async function commitEdit() {
    const num = (draft.employee_number ?? "").trim();
    if (!num) {
      setToast({ kind: "error", message: "社員番号は必須です" });
      return;
    }
    const payload = {
      ...draft,
      employee_number: num,
      email: draft.email ? draft.email.trim().toLowerCase() : null,
      full_name: draft.full_name ? draft.full_name.trim() : null,
      display_name: draft.display_name ? draft.display_name.trim() : null,
    };
    const res = await upsert(payload);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
      return;
    }
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setToast({ kind: "info", message: "従業員情報を保存しました" });
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    const ok = await removeOne(pendingDelete.employee_number);
    setPendingDelete(null);
    setToast(
      ok
        ? { kind: "info", message: "従業員を削除しました" }
        : { kind: "error", message: "削除に失敗しました" },
    );
  }

  async function handleFileImport(file: File) {
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const summary = await importCsv(text);
      setImportResult(summary);
    } finally {
      setImporting(false);
    }
  }

  async function handleUrlImport() {
    if (!urlDraft.trim()) return;
    setSheetCsvUrl(urlDraft.trim());
    setImporting(true);
    setImportResult(null);
    try {
      const summary = await importFromSheetUrl(urlDraft.trim());
      setImportResult(summary);
    } finally {
      setImporting(false);
    }
  }

  /** 保存済みの「ウェブに公開」URLからワンクリックで再取込。 */
  async function handleQuickReimport() {
    if (!sheetCsvUrl) return;
    setImporting(true);
    setImportResult(null);
    try {
      const summary = await importFromSheetUrl(sheetCsvUrl);
      setImportResult(summary);
      if (summary.errors.length > 0) {
        setShowImporter(true);
        setToast({
          kind: "error",
          message: `シート再取込でエラー ${summary.errors.length} 件（詳細はインポート欄）`,
        });
      } else {
        setToast({
          kind: "info",
          message: `シートから再取込：新規 ${summary.inserted} ／ 更新 ${summary.updated} ／ スキップ ${summary.skipped}`,
        });
      }
    } finally {
      setImporting(false);
    }
  }

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">従業員マスター</h1>
          <p className="page__subtitle">
            登録 {employees.length} 名 ／ 在籍 {headcounts.total} 名（
            <span className="emppage__chip">正社員 {headcounts.seishain}</span>
            <span className="emppage__chip">限定正社員 {headcounts.limited}</span>
            <span className="emppage__chip">アルバイト・パート {headcounts.casual}</span>
            ） ／ 退職 {employees.length - headcounts.total} 名
          </p>
        </div>
        <div className="page__actions">
          {isMaster && sheetCsvUrl && (
            <button
              className="btn"
              onClick={handleQuickReimport}
              disabled={importing}
              title="保存済みの「ウェブに公開」URL（SmartHR自動連携タブ）から最新の名簿を再取込します"
            >
              {importing ? "取り込み中…" : "⟳ シートから再取込"}
            </button>
          )}
          {isMaster && (
            <button
              className="btn btn--ghost"
              onClick={() => setShowImporter((v) => !v)}
            >
              {showImporter ? "▲ インポートを閉じる" : "▾ CSVインポート"}
            </button>
          )}
          {isMaster && (
            <button className="btn btn--primary" onClick={startNew}>
              ＋新規追加
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="loaderr" role="alert">
          <span className="loaderr__msg">⚠ {error}</span>
          <button
            className="btn btn--xs"
            onClick={() => {
              refresh();
              refreshProfiles();
            }}
          >
            再読み込み
          </button>
        </div>
      )}

      {showImporter && isMaster && (
        <fieldset className="empmgr__import">
          <legend className="field__label">CSVインポート（社員番号で突合・上書き）</legend>
          <p className="modal__body" style={{ fontSize: 12, marginBottom: 8 }}>
            連携元は従業員名簿スプレッドシートの「SmartHR自動連携」タブです。取込方法は2つ：
            ①Google Sheetsの「ファイル ＞ 共有 ＞ ウェブに公開」で対象タブを
            <strong>CSV形式で公開</strong>したURLを貼り付けて「URLから取込」／
            ②シートをCSVでダウンロードしてファイルアップロード。
            既存の社員番号は上書き、新規番号は追加されます（削除はされません）。
            <strong>社員番号が空の行はスキップ</strong>されます。
            「使用ネーム」は取込では変更されません（手動管理）。
          </p>
          <div className="empmgr__importRow">
            <input
              className="field__input"
              placeholder="https://docs.google.com/spreadsheets/d/e/.../pub?gid=...&output=csv"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="btn"
              onClick={handleUrlImport}
              disabled={importing || !urlDraft.trim()}
            >
              {importing ? "取り込み中…" : "URLから取込"}
            </button>
          </div>
          <div className="empmgr__importRow">
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFileImport(f);
                e.target.value = "";
              }}
              disabled={importing}
            />
          </div>
          {importResult && (
            <div className="empmgr__importResult">
              <strong>取込結果：</strong>
              対象 {importResult.totalRows} 行 ／ 新規 {importResult.inserted} ／
              更新 {importResult.updated} ／ スキップ {importResult.skipped}
              {importResult.errors.length > 0 && (
                <ul>
                  {importResult.errors.slice(0, 5).map((er, i) => (
                    <li key={i}>{er}</li>
                  ))}
                  {importResult.errors.length > 5 && (
                    <li>…ほか {importResult.errors.length - 5} 件</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </fieldset>
      )}

      <div className="emppage__filters">
        <div className="emppage__viewToggle" role="tablist" aria-label="表示切替">
          <button
            role="tab"
            aria-selected={viewMode === "list"}
            className={`emppage__viewBtn ${viewMode === "list" ? "is-active" : ""}`}
            onClick={() => setViewMode("list")}
          >
            ☰ 一覧
          </button>
          <button
            role="tab"
            aria-selected={viewMode === "gallery"}
            className={`emppage__viewBtn ${viewMode === "gallery" ? "is-active" : ""}`}
            onClick={() => setViewMode("gallery")}
          >
            ▦ ギャラリー
          </button>
        </div>
        <input
          className="field__input"
          placeholder="氏名 / 部署 / メール / 役職などで絞り込み"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
          style={{ flex: "2 1 200px" }}
        />
        <select
          className="field__input"
          value={retirementMode}
          onChange={(e) => {
            setRetirementMode(e.target.value as "active" | "retired" | "all");
            setPage(1);
          }}
          title="退職状態"
        >
          <option value="active">在籍のみ</option>
          <option value="retired">退職のみ</option>
          <option value="all">全て</option>
        </select>
        <select
          className="field__input"
          value={empTypeFilter}
          onChange={(e) => {
            setEmpTypeFilter(e.target.value);
            setPage(1);
          }}
          title="雇用形態でフィルタ"
        >
          <option value="">雇用形態：全て</option>
          {distinctEmpTypes.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          className="field__input"
          value={deptFilter}
          onChange={(e) => {
            setDeptFilter(e.target.value);
            setPage(1);
          }}
          title="部署でフィルタ"
        >
          <option value="">部署：全て</option>
          {distinctDepts.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          className="field__input"
          value={positionFilter}
          onChange={(e) => {
            setPositionFilter(e.target.value);
            setPage(1);
          }}
          title="役職でフィルタ"
        >
          <option value="">役職：全て</option>
          {distinctPositions.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        {(filter || empTypeFilter || deptFilter || positionFilter || retirementMode !== "active") && (
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => {
              setFilter("");
              setEmpTypeFilter("");
              setDeptFilter("");
              setPositionFilter("");
              setRetirementMode("active");
              setPage(1);
            }}
            title="フィルタをクリア"
          >
            ✕ クリア
          </button>
        )}
        <span className="emppage__count">
          <strong>{filtered.length}</strong> 名 一致
          {filtered.length !== employees.length && (
            <span className="emppage__countSub"> / 全 {employees.length}</span>
          )}
        </span>
      </div>

      {viewMode === "gallery" && (
        <div className="emppage__galleryWrap">
          {loading && (
            <div className="emppage__gallery" aria-hidden>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="empcard">
                  <span className="empcard__photo skl" />
                  <span className="empcard__body">
                    <span className="skl skl--text" style={{ width: "60%" }} />
                    <span className="skl skl--text" style={{ width: "85%" }} />
                    <span className="skl skl--text" style={{ width: "45%" }} />
                  </span>
                </div>
              ))}
            </div>
          )}
          {!loading && filtered.length === 0 && (
            <p className="usermgr__empty">
              {employees.length === 0
                ? "従業員が登録されていません。CSVインポートか「＋新規追加」から始めてください。"
                : "条件に一致する従業員がいません。"}
            </p>
          )}
          <div className="emppage__gallery">
            {!loading &&
              pageRows.map((emp) => {
                const prof = profiles[emp.employee_number];
                const avatarPath = avatarPathOf(prof);
                const avatarUrl = avatarPath ? photoUrls[avatarPath] : undefined;
                const name = employeeName(emp);
                const isInactive = !!emp.left_at && emp.left_at <= today;
                return (
                  <button
                    key={emp.employee_number}
                    className={`empcard ${isInactive ? "is-inactive" : ""}`}
                    onClick={() => openDetail(emp)}
                    title="クリックで詳細ページへ"
                  >
                    <span className="empcard__photo" aria-hidden>
                      {avatarUrl ? (
                        <img src={avatarUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="empcard__initial">
                          {name.trim()[0]?.toUpperCase() ?? "?"}
                        </span>
                      )}
                    </span>
                    <span className="empcard__body">
                      <span className="empcard__name">{name}</span>
                      {prof?.nickname && (
                        <span className="empcard__nickname">（{prof.nickname}）</span>
                      )}
                      <span className="empcard__sub">{emp.department ?? "—"}</span>
                      <span className="empcard__sub">{emp.position_title ?? "—"}</span>
                      {(() => {
                        const mbti = normalizeMbti(prof?.mbti ?? null);
                        const top = normalizeStrengthIds(prof?.strengths ?? [])[0];
                        const topQ = top ? STRENGTH_BY_ID[top] : undefined;
                        const aiLevel = aiLevelOf.get(emp.employee_number);
                        if (!mbti && !topQ && !aiLevel) return null;
                        return (
                          <span className="empcard__tags">
                            {aiLevel && <AiLevelBadge level={aiLevel.level} size="sm" />}
                            {mbti && (
                              <span
                                className="empcard__mbti"
                                style={{ borderColor: MBTI_GROUP_COLOR[MBTI_BY_CODE[mbti].group] }}
                              >
                                {mbti}
                              </span>
                            )}
                            {topQ && (
                              <span
                                className="empcard__strength"
                                style={{ background: STRENGTH_DOMAIN_COLOR[topQ.domain] }}
                              >
                                {topQ.name_ja}
                              </span>
                            )}
                          </span>
                        );
                      })()}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      )}

      {viewMode === "list" && (
      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th>社員番号</th>
              <th>氏名（戸籍名）</th>
              <th>
                使用ネーム
                <span
                  className="emppage__thHint"
                  title="Talent Hub上で表示する名前（旧姓の継続利用など）。空欄なら戸籍名を表示します。シート取込では上書きされません。"
                >
                  ⓘ
                </span>
              </th>
              <th>メール</th>
              <th>雇用形態</th>
              <th>部署</th>
              <th>役職</th>
              <th>入社日</th>
              <th>退職日</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 8 }, (_, i) => (
                <tr key={`skl-${i}`} aria-hidden>
                  {Array.from({ length: 10 }, (_, j) => (
                    <td key={j}>
                      <span className="skl skl--text" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && editing === "__new__" && (
              <EditableRow
                draft={draft}
                onChange={setDraft}
                onCommit={commitEdit}
                onCancel={cancelEdit}
                isNew
              />
            )}
            {!loading && filtered.length === 0 && editing !== "__new__" && (
              <tr>
                <td colSpan={10} className="usermgr__empty">
                  {employees.length === 0
                    ? "従業員が登録されていません。CSVインポートか「＋新規追加」から始めてください。"
                    : "条件に一致する従業員がいません。"}
                </td>
              </tr>
            )}
            {!loading &&
              pageRows.map((emp) => {
                const isInactive = !!emp.left_at && emp.left_at <= today;
                if (editing === emp.employee_number) {
                  return (
                    <EditableRow
                      key={emp.employee_number}
                      draft={draft}
                      onChange={setDraft}
                      onCommit={commitEdit}
                      onCancel={cancelEdit}
                    />
                  );
                }
                return (
                  <tr key={emp.employee_number} className={isInactive ? "is-inactive" : ""}>
                    <td><code>{emp.employee_number}</code></td>
                    <td>
                      {emp.full_name ? (
                        <button
                          className="emppage__nameLink"
                          onClick={() => openDetail(emp)}
                          title="クリックで詳細ページへ"
                        >
                          {emp.full_name}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {emp.display_name?.trim() ? (
                        <strong>{emp.display_name}</strong>
                      ) : (
                        <span className="emppage__dimmed">—</span>
                      )}
                    </td>
                    <td>{emp.email ?? "—"}</td>
                    <td>{emp.employment_type ?? "—"}</td>
                    <td>{emp.department ?? "—"}</td>
                    <td>{emp.position_title ?? "—"}</td>
                    <td>{emp.hired_at ?? "—"}</td>
                    <td>
                      {emp.left_at ? (
                        <span className="empmgr__leftBadge">{emp.left_at}</span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                      {isMaster && (
                        <>
                          <button
                            className="btn btn--ghost btn--xs"
                            onClick={() => startEdit(emp)}
                          >
                            編集
                          </button>
                          <button
                            className="btn btn--ghost btn--xs"
                            onClick={() => setPendingDelete(emp)}
                          >
                            削除
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        totalRows={filtered.length}
        pageSize={PAGE_SIZE}
        onChange={setPage}
      />

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">従業員の削除</h3>
            <p className="modal__body">
              <code>{pendingDelete.employee_number}</code>{" "}
              {pendingDelete.full_name ?? ""} を削除します。
              <br />
              <strong>
                本人のプロフィール・人事機密情報・写真も一緒に削除されます（復元できません）。
              </strong>
              <br />
              退職した方は削除ではなく「退職日」を入れることをお勧めします（履歴が残せます）。
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setPendingDelete(null)}>
                キャンセル
              </button>
              <button className="btn btn--danger" onClick={confirmRemove}>
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Pagination({
  page,
  totalPages,
  totalRows,
  pageSize,
  onChange,
}: {
  page: number;
  totalPages: number;
  totalRows: number;
  pageSize: number;
  onChange: (p: number) => void;
}) {
  if (totalRows === 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalRows);

  // Build a compact page list with ellipses for long sets.
  const pages: (number | "...")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push("...");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) {
      pages.push(i);
    }
    if (page < totalPages - 2) pages.push("...");
    pages.push(totalPages);
  }

  return (
    <nav className="pagination" aria-label="ページネーション">
      <span className="pagination__range">
        {first}–{last} / {totalRows}
      </span>
      <button
        className="btn btn--ghost btn--xs"
        onClick={() => onChange(Math.max(1, page - 1))}
        disabled={page === 1}
      >
        ‹ 前へ
      </button>
      {pages.map((p, i) =>
        p === "..." ? (
          <span key={`e${i}`} className="pagination__ellipsis">…</span>
        ) : (
          <button
            key={p}
            className={`pagination__page ${p === page ? "is-active" : ""}`}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        className="btn btn--ghost btn--xs"
        onClick={() => onChange(Math.min(totalPages, page + 1))}
        disabled={page === totalPages}
      >
        次へ ›
      </button>
    </nav>
  );
}

function EditableRow({
  draft,
  onChange,
  onCommit,
  onCancel,
  isNew,
}: {
  draft: Partial<EmployeeRow> & { employee_number: string };
  onChange: (next: Partial<EmployeeRow> & { employee_number: string }) => void;
  onCommit: () => void;
  onCancel: () => void;
  isNew?: boolean;
}) {
  function set<K extends keyof EmployeeRow>(key: K, val: EmployeeRow[K] | string | null) {
    onChange({ ...draft, [key]: (val === "" ? null : val) as EmployeeRow[K] });
  }

  return (
    <tr className="empmgr__editRow">
      <td>
        <input
          className="field__input field__input--xs"
          value={draft.employee_number}
          onChange={(e) => set("employee_number", e.target.value)}
          placeholder="例: 0001"
          disabled={!isNew}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          placeholder="例: 山田 太郎"
          value={draft.full_name ?? ""}
          onChange={(e) => set("full_name", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          placeholder="例: 旧姓 太郎（空欄=戸籍名）"
          value={draft.display_name ?? ""}
          onChange={(e) => set("display_name", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          type="email"
          value={draft.email ?? ""}
          onChange={(e) => set("email", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          value={draft.employment_type ?? ""}
          onChange={(e) => set("employment_type", e.target.value)}
          placeholder="正社員"
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          value={draft.department ?? ""}
          onChange={(e) => set("department", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          value={draft.position_title ?? ""}
          onChange={(e) => set("position_title", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          type="date"
          value={draft.hired_at ?? ""}
          onChange={(e) => set("hired_at", e.target.value)}
        />
      </td>
      <td>
        <input
          className="field__input field__input--xs"
          type="date"
          value={draft.left_at ?? ""}
          onChange={(e) => set("left_at", e.target.value)}
        />
      </td>
      <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
        <button className="btn btn--primary btn--xs" onClick={onCommit}>
          保存
        </button>
        <button className="btn btn--ghost btn--xs" onClick={onCancel}>
          取消
        </button>
      </td>
    </tr>
  );
}
