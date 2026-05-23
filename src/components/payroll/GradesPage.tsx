import { useEffect, useMemo, useState } from "react";
import { usePayrollStore } from "../../store/usePayrollStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useOrgStore } from "../../store/useOrgStore";
import type { CareerTrack, GradeRow, GradeTier } from "../../lib/supabase";

type TrackTab = CareerTrack | "non_manager";

const TRACK_LABEL: Record<TrackTab, string> = {
  management: "マネジメント",
  specialist: "スペシャリスト",
  diverse: "多様な正社員",
  non_manager: "非管理職（共通）",
};

const TIER_LABEL: Record<GradeTier, string> = {
  officer: "役員",
  manager: "管理職",
  non_manager: "非管理職",
};

function fmtMoney(yen: number | null | undefined): string {
  if (yen == null) return "—";
  if (yen >= 10000) return `${(yen / 10000).toFixed(yen % 10000 === 0 ? 0 : 1)}万`;
  return yen.toLocaleString();
}

/**
 * 等級マスター閲覧・編集ページ。3トラック（マネジメント / スペシャリスト /
 * 多様な正社員）+ 全トラック共通の非管理職階層をタブで切替。特権管理者・
 * マスターのみ各セルをインライン編集できる（RLS で書き込み権限がない人は
 * Supabase 側で reject される）。
 */
export function GradesPage() {
  const grades = usePayrollStore((s) => s.grades);
  const loaded = usePayrollStore((s) => s.loaded);
  const loading = usePayrollStore((s) => s.loading);
  const error = usePayrollStore((s) => s.error);
  const refresh = usePayrollStore((s) => s.refresh);
  const upsertGrade = usePayrollStore((s) => s.upsertGrade);
  const role = useAuthStore((s) => s.currentUser?.role);
  const canEdit = role === "master" || role === "privileged_admin";
  const setToast = useOrgStore((s) => s.setToast);

  const [tab, setTab] = useState<TrackTab>("management");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<GradeRow>>({});

  useEffect(() => {
    if (!loaded) refresh();
  }, [loaded, refresh]);

  const filtered = useMemo(() => {
    let rows: GradeRow[];
    if (tab === "non_manager") {
      // Shared tier across management & specialist (career_track is null).
      rows = grades.filter((g) => g.tier === "non_manager" && g.career_track === null);
    } else {
      rows = grades.filter((g) => g.career_track === tab);
    }
    return [...rows].sort((a, b) => a.sort_order - b.sort_order);
  }, [grades, tab]);

  function startEdit(g: GradeRow) {
    setEditing(g.code);
    setDraft({ ...g });
  }
  function cancelEdit() {
    setEditing(null);
    setDraft({});
  }
  async function commitEdit() {
    if (!draft.code) return;
    const res = await upsertGrade({ ...draft, code: draft.code });
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存失敗" });
      return;
    }
    setToast({ kind: "info", message: "等級情報を更新しました" });
    cancelEdit();
  }

  return (
    <main className="page payroll-page">
      <div className="page__header">
        <div>
          <h1 className="page__title">等級マスター</h1>
          <p className="page__subtitle">
            会社共通の等級・期待値・月給レンジ・職種別肩書きを管理します。
            {canEdit ? "編集権限があります（各行の「編集」から変更可）。" : "閲覧のみです（編集は特権管理者のみ）。"}
          </p>
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      <div className="payroll-tabs" role="tablist">
        {(["management", "specialist", "non_manager", "diverse"] as TrackTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`payroll-tab ${tab === t ? "is-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TRACK_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table grades-table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>コード</th>
              <th style={{ width: 100 }}>階層</th>
              <th>等級名</th>
              <th>期待値</th>
              <th style={{ width: 100, textAlign: "right" }}>月給下限</th>
              <th style={{ width: 90, textAlign: "right" }}>賞与</th>
              <th style={{ width: 110, textAlign: "right" }}>年収上限</th>
              <th>肩書き（営業）</th>
              {canEdit && <th style={{ width: 100 }} />}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={canEdit ? 9 : 8} className="usermgr__empty">読み込み中…</td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={canEdit ? 9 : 8} className="usermgr__empty">
                  該当する等級がありません
                </td>
              </tr>
            )}
            {!loading && filtered.map((g) => {
              if (editing === g.code) {
                return (
                  <tr key={g.code} className="grades-table__edit">
                    <td><code>{g.code}</code></td>
                    <td>{TIER_LABEL[g.tier]}</td>
                    <td>
                      <input
                        className="field__input field__input--xs"
                        value={draft.label ?? ""}
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                      />
                    </td>
                    <td>
                      <textarea
                        className="field__input field__input--xs"
                        rows={2}
                        value={draft.expectation ?? ""}
                        onChange={(e) => setDraft({ ...draft, expectation: e.target.value })}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        className="field__input field__input--xs grades-table__num"
                        type="number"
                        value={draft.min_monthly_salary ?? ""}
                        onChange={(e) => setDraft({ ...draft, min_monthly_salary: e.target.value ? Number(e.target.value) : null })}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        className="field__input field__input--xs grades-table__num"
                        type="number"
                        step="0.5"
                        value={draft.bonus_months ?? ""}
                        onChange={(e) => setDraft({ ...draft, bonus_months: e.target.value ? Number(e.target.value) : null })}
                      />
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <input
                        className="field__input field__input--xs grades-table__num"
                        type="number"
                        value={draft.annual_cap ?? ""}
                        onChange={(e) => setDraft({ ...draft, annual_cap: e.target.value ? Number(e.target.value) : null })}
                      />
                    </td>
                    <td>
                      <input
                        className="field__input field__input--xs"
                        value={(draft.title_by_function ?? {}).frontend ?? ""}
                        onChange={(e) => setDraft({ ...draft, title_by_function: { ...(draft.title_by_function ?? {}), frontend: e.target.value } })}
                      />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn btn--primary btn--xs" onClick={commitEdit}>保存</button>{" "}
                      <button className="btn btn--ghost btn--xs" onClick={cancelEdit}>取消</button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={g.code}>
                  <td><code>{g.code}</code></td>
                  <td>{TIER_LABEL[g.tier]}</td>
                  <td>{g.label}</td>
                  <td style={{ whiteSpace: "pre-wrap", fontSize: 12, color: "#475569" }}>{g.expectation ?? "—"}</td>
                  <td className="grades-table__num">{fmtMoney(g.min_monthly_salary)}</td>
                  <td className="grades-table__num">{g.bonus_months != null ? `${g.bonus_months}ヶ月` : "—"}</td>
                  <td className="grades-table__num">{fmtMoney(g.annual_cap)}</td>
                  <td style={{ fontSize: 12 }}>{g.title_by_function?.frontend ?? "—"}</td>
                  {canEdit && (
                    <td style={{ textAlign: "right" }}>
                      <button className="btn btn--ghost btn--xs" onClick={() => startEdit(g)}>編集</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
}
