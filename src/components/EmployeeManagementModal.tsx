import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../store/useUiStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { useAuthStore } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import type { EmployeeRow } from "../lib/supabase";
import type { ImportSummary } from "../store/useEmployeesStore";

const EMPTY_DRAFT: Partial<EmployeeRow> & { employee_number: string } = {
  employee_number: "",
  last_name: "",
  first_name: "",
  email: "",
  employment_type: "",
  department: "",
  position_title: "",
  hired_at: null,
  left_at: null,
};

export function EmployeeManagementModal() {
  const open = useUiStore((s) => s.showEmployees);
  const setOpen = useUiStore((s) => s.setShowEmployees);
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

  const isMaster = currentUser?.role === "master";

  const [filter, setFilter] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<EmployeeRow> & { employee_number: string }>(EMPTY_DRAFT);
  const [pendingDelete, setPendingDelete] = useState<EmployeeRow | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportSummary | null>(null);
  const [urlDraft, setUrlDraft] = useState(sheetCsvUrl);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    setUrlDraft(sheetCsvUrl);
  }, [sheetCsvUrl, open]);

  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return employees
      .filter((e) => {
        if (!showInactive && e.left_at && e.left_at <= today) return false;
        if (!q) return true;
        const blob = [
          e.employee_number,
          e.last_name,
          e.first_name,
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
  }, [employees, filter, showInactive, today]);

  if (!open) return null;

  function close() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setOpen(false);
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

  return (
    <>
      <div className="modal-backdrop" onClick={close}>
        <div
          className="modal modal--xwide"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="modal__title">従業員名簿</h3>
          <p className="modal__body">
            ツールに登録された従業員のマスター。バージョンに反映できていないメンバーをサイドバーに自動で出すために使われます。
            退職日が今日以前のメンバーは未配置メンバーリストから自動的に除外されます。
          </p>

          {error && <p className="versions__error">{error}</p>}

          <div className="empmgr__toolbar">
            <input
              className="field__input"
              placeholder="名前 / 部署 / メールで検索"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ flex: 1 }}
            />
            <label className="checkbox" style={{ flexShrink: 0 }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              <span>退職者も表示</span>
            </label>
            {isMaster && (
              <button className="btn btn--primary" onClick={startNew}>
                ＋新規追加
              </button>
            )}
          </div>

          <div className="empmgr__tableWrap">
            <table className="empmgr__table">
              <thead>
                <tr>
                  <th>社員番号</th>
                  <th>氏名</th>
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
                {loading && (
                  <tr>
                    <td colSpan={9} className="usermgr__empty">
                      読み込み中…
                    </td>
                  </tr>
                )}
                {!loading && editing === "__new__" && (
                  <EditableRow
                    draft={draft}
                    onChange={setDraft}
                    onCommit={commitEdit}
                    onCancel={cancelEdit}
                    isNew
                  />
                )}
                {!loading && visible.length === 0 && editing !== "__new__" && (
                  <tr>
                    <td colSpan={9} className="usermgr__empty">
                      従業員が登録されていません。下のCSVインポートか「＋新規追加」から始めてください。
                    </td>
                  </tr>
                )}
                {!loading &&
                  visible.map((emp) => {
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
                          {emp.last_name ?? ""} {emp.first_name ?? ""}
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

          {isMaster && (
            <fieldset className="empmgr__import">
              <legend className="field__label">CSVインポート（社員番号で突合・上書き）</legend>
              <p className="modal__body" style={{ fontSize: 12, marginBottom: 8 }}>
                Google Sheetsで「ファイル ＞ 共有 ＞ ウェブに公開」から
                <strong>「SmartHR自動連携」タブをCSV形式で公開</strong>
                したURLを下に貼り付けるか、CSVファイルを直接アップロードしてください。
                既存の社員番号は上書き、新規番号は追加されます。
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
                  対象 {importResult.totalRows} 行 ／
                  新規 {importResult.inserted} ／
                  更新 {importResult.updated} ／
                  スキップ {importResult.skipped}
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

          <div className="modal__actions">
            <button className="btn" onClick={close}>
              閉じる
            </button>
          </div>
        </div>
      </div>

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">従業員の削除</h3>
            <p className="modal__body">
              <code>{pendingDelete.employee_number}</code>{" "}
              {pendingDelete.last_name} {pendingDelete.first_name} を削除します。
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
    </>
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
          placeholder="姓"
          value={draft.last_name ?? ""}
          onChange={(e) => set("last_name", e.target.value)}
          style={{ marginRight: 4, width: "48%" }}
        />
        <input
          className="field__input field__input--xs"
          placeholder="名"
          value={draft.first_name ?? ""}
          onChange={(e) => set("first_name", e.target.value)}
          style={{ width: "48%" }}
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
