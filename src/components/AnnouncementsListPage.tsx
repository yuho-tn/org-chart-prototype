import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../store/useUiStore";
import { useAnnouncementsStore } from "../store/useAnnouncementsStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useAuthStore } from "../store/useAuthStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { useOrgStore } from "../store/useOrgStore";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  computeAnnouncement,
  emptyPayload,
  formatPeriodHeading,
} from "../lib/announcement";
import type { OrgNode } from "../lib/types";

/**
 * Announcements index page. Lists existing 人事発令 records and lets a master
 * generate a new one by picking two confirmed versions (前月 → 今月) and a
 * period. The diff runs client-side from the snapshots; the resulting
 * payload is stored in hr_announcements and editable on the detail page.
 */
export function AnnouncementsListPage() {
  const navigate = useUiStore((s) => s.navigate);
  const list = useAnnouncementsStore((s) => s.list);
  const loading = useAnnouncementsStore((s) => s.loading);
  const error = useAnnouncementsStore((s) => s.error);
  const refresh = useAnnouncementsStore((s) => s.refresh);
  const create = useAnnouncementsStore((s) => s.create);
  const removeOne = useAnnouncementsStore((s) => s.remove);

  const versions = useVersionsStore((s) => s.versions);
  const refreshVersions = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const currentUser = useAuthStore((s) => s.currentUser);
  const setToast = useOrgStore((s) => s.setToast);

  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; period: string } | null>(null);

  useEffect(() => {
    refresh();
    refreshVersions();
    refreshEmployees();
  }, [refresh, refreshVersions, refreshEmployees]);

  const isMaster = currentUser?.role === "master";

  const sorted = useMemo(
    () => [...list].sort((a, b) => b.period.localeCompare(a.period)),
    [list],
  );

  async function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    const ok = await removeOne(id);
    if (ok) {
      setToast({ kind: "info", message: "発令資料を削除しました" });
    } else {
      const detail = useAnnouncementsStore.getState().error;
      setToast({ kind: "error", message: detail ?? "削除に失敗しました" });
    }
  }

  async function handleCreate(input: {
    period: string;
    title: string;
    versionAId: string | null;
    versionBId: string | null;
  }) {
    setCreating(false);
    let nodesA: OrgNode[] = [];
    let nodesB: OrgNode[] = [];
    if (input.versionAId) {
      nodesA = (await getSnapshot(input.versionAId)) ?? [];
    }
    if (input.versionBId) {
      nodesB = (await getSnapshot(input.versionBId)) ?? [];
    }
    const payload = computeAnnouncement(nodesA, nodesB, employees, input.period);
    const row = await create({
      period: input.period,
      title: input.title || `${formatPeriodHeading(input.period)} 人事発令`,
      version_a_id: input.versionAId,
      version_b_id: input.versionBId,
      payload,
      created_by_email: currentUser?.email ?? null,
    });
    if (!row) {
      const detail = useAnnouncementsStore.getState().error;
      setToast({
        kind: "error",
        message: detail ?? "発令資料の作成に失敗しました",
      });
      return;
    }
    setToast({ kind: "info", message: "発令資料を作成しました" });
    navigate({ name: "announcement", id: row.id });
  }

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">人事発令</h1>
          <p className="page__subtitle">
            月次の確定版を比較して人事発令の通知資料を生成します。
          </p>
        </div>
        <div className="page__actions">
          {isMaster && (
            <button
              className="btn btn--primary"
              onClick={() => setCreating(true)}
            >
              ＋新規作成
            </button>
          )}
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      <div className="annlist">
        {loading && list.length === 0 && (
          <p className="versions__empty">読み込み中…</p>
        )}
        {!loading && list.length === 0 && (
          <p className="versions__empty">
            発令資料はまだありません。
            {isMaster && <>「＋新規作成」から作成してください。</>}
          </p>
        )}
        {sorted.map((row) => (
          <article
            key={row.id}
            className="annlist__card"
            onClick={() => navigate({ name: "announcement", id: row.id })}
            role="button"
            tabIndex={0}
          >
            <div className="annlist__head">
              <div>
                <span className="annlist__period">{formatPeriodHeading(row.period)}</span>
                <h3 className="annlist__title">{row.title}</h3>
              </div>
              {(isMaster || row.created_by_email === currentUser?.email) && (
                <button
                  className="btn btn--ghost btn--xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDelete({ id: row.id, period: row.period });
                  }}
                >
                  削除
                </button>
              )}
            </div>
            <div className="annlist__counts">
              入社 {row.payload?.hires?.length ?? 0} ／
              退職 {row.payload?.leaves?.length ?? 0} ／
              DIV間 {row.payload?.div_moves?.length ?? 0} ／
              TM間 {row.payload?.tm_moves?.length ?? 0} ／
              任用 {row.payload?.promotions?.length ?? 0}
            </div>
          </article>
        ))}
      </div>

      {creating && (
        <CreateDialog
          versions={versions.filter((v) => v.is_confirmed)}
          onCancel={() => setCreating(false)}
          onCreate={handleCreate}
        />
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="発令資料の削除"
          message={
            <>
              この発令資料（{formatPeriodHeading(pendingDelete.period)}）を削除します。よろしいですか？
            </>
          }
          confirmLabel="削除する"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </main>
  );
}

function CreateDialog({
  versions,
  onCancel,
  onCreate,
}: {
  versions: { id: string; name: string; confirmed_period?: string | null }[];
  onCancel: () => void;
  onCreate: (input: {
    period: string;
    title: string;
    versionAId: string | null;
    versionBId: string | null;
  }) => void;
}) {
  const todayMonth = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const [period, setPeriod] = useState(todayMonth);
  const [title, setTitle] = useState("");
  const [versionAId, setVersionAId] = useState<string>("");
  const [versionBId, setVersionBId] = useState<string>("");

  // Pre-fill version pickers based on the chosen period: B = the version
  // confirmed for this period, A = the previous-month version.
  useEffect(() => {
    const sameMonth = versions.find((v) => v.confirmed_period === period);
    if (sameMonth) setVersionBId(sameMonth.id);
    const [y, m] = period.split("-").map(Number);
    if (!y || !m) return;
    const prev = new Date(y, m - 2, 1);
    const prevPeriod = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
    const prevMatch = versions.find((v) => v.confirmed_period === prevPeriod);
    if (prevMatch) setVersionAId(prevMatch.id);
  }, [period, versions]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">新しい人事発令資料を作成</h3>
        <p className="modal__body">
          対象月と、比較する2つの確定版を選んでください。差分から自動的に
          入社・退職・DIV間異動・TM間異動・任用の各セクションが生成されます。
          作成後にすべての項目を編集できます。
        </p>

        <label className="field">
          <span className="field__label">対象年月</span>
          <input
            className="field__input"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
        </label>

        <label className="field" style={{ marginTop: 10 }}>
          <span className="field__label">タイトル（任意）</span>
          <input
            className="field__input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={`例：${formatPeriodHeading(period)} 人事発令`}
          />
        </label>

        <label className="field" style={{ marginTop: 10 }}>
          <span className="field__label">前月の確定版（変更前）</span>
          <select
            className="field__input"
            value={versionAId}
            onChange={(e) => setVersionAId(e.target.value)}
          >
            <option value="">（選択しない＝全員が新規扱い）</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.confirmed_period
                  ? `${formatPeriodHeading(v.confirmed_period)}：${v.name}`
                  : v.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field" style={{ marginTop: 10 }}>
          <span className="field__label">対象月の確定版（変更後）</span>
          <select
            className="field__input"
            value={versionBId}
            onChange={(e) => setVersionBId(e.target.value)}
          >
            <option value="">（選択しない＝異動なし扱い）</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.confirmed_period
                  ? `${formatPeriodHeading(v.confirmed_period)}：${v.name}`
                  : v.name}
              </option>
            ))}
          </select>
        </label>

        {versions.length === 0 && (
          <p className="versions__error" style={{ marginTop: 10 }}>
            確定版がまだ登録されていません。サイドバーの「FIX登録」で確定版を作成してから戻ってきてください。
          </p>
        )}

        <div className="modal__actions" style={{ marginTop: 16 }}>
          <button className="btn btn--ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn btn--primary"
            onClick={() =>
              onCreate({
                period,
                title,
                versionAId: versionAId || null,
                versionBId: versionBId || null,
              })
            }
            disabled={!period || (!versionAId && !versionBId)}
          >
            作成する
          </button>
        </div>
      </div>
    </div>
  );
}

// Re-export helper for the empty payload + heading formatter so external
// consumers don't have to dual-import. (Currently used only internally.)
export { emptyPayload, formatPeriodHeading };
