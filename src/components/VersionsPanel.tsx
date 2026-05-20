import { useEffect, useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "../store/useVersionsStore";
import { useAuthStore, accessForVersion } from "../store/useAuthStore";
import { useUiStore } from "../store/useUiStore";
import { SaveVersionDialog } from "./SaveVersionDialog";
import { HoldToConfirm } from "./HoldToConfirm";
import { getAuthor } from "../lib/author";

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}日前`;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fullDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VersionsPanel() {
  const versions = useVersionsStore((s) => s.versions);
  const loading = useVersionsStore((s) => s.loading);
  const error = useVersionsStore((s) => s.error);
  const refresh = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const remove = useVersionsStore((s) => s.remove);
  const setConfirmation = useVersionsStore((s) => s.setConfirmation);
  const duplicate = useVersionsStore((s) => s.duplicate);
  const updatePermissions = useVersionsStore((s) => s.updatePermissions);
  const rename = useVersionsStore((s) => s.rename);

  const dirty = useOrgStore((s) => s.dirty);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const setCurrentVersionLabel = useOrgStore((s) => s.setCurrentVersionLabel);
  const setToast = useOrgStore((s) => s.setToast);
  const currentUser = useAuthStore((s) => s.currentUser);
  const setViewOnly = useUiStore((s) => s.setViewOnly);
  const setFilesDrawerOpen = useUiStore((s) => s.setFilesDrawerOpen);

  const [showSave, setShowSave] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [pendingFix, setPendingFix] = useState<{ id: string; name: string } | null>(null);
  const [pendingRename, setPendingRename] = useState<{ id: string; name: string } | null>(null);
  const [tab, setTab] = useState<"draft" | "confirmed">("draft");

  const visible = useMemo(() => {
    return versions
      .map((v) => ({ v, access: accessForVersion(currentUser, v) }))
      .filter((x) => x.access !== null) as {
        v: (typeof versions)[number];
        access: { view: true; edit: boolean };
      }[];
  }, [versions, currentUser]);

  const confirmedList = useMemo(
    () =>
      visible
        .filter((x) => x.v.is_confirmed)
        .sort((a, b) => {
          const pa = a.v.confirmed_period ?? "";
          const pb = b.v.confirmed_period ?? "";
          return pb.localeCompare(pa);
        }),
    [visible],
  );
  const draftList = useMemo(
    () => visible.filter((x) => !x.v.is_confirmed),
    [visible],
  );

  const tabList = tab === "confirmed" ? confirmedList : draftList;

  useEffect(() => {
    if (isSupabaseConfigured) refresh();
  }, [refresh]);

  async function handleLoad(
    id: string,
    name: string,
    canEdit: boolean,
    isConfirmed: boolean,
  ) {
    if (dirty) {
      const ok = window.confirm(
        "未保存の変更があります。このファイルを開くと現在の変更は失われます。続けますか？",
      );
      if (!ok) return;
    }
    const nodes = await getSnapshot(id);
    if (!nodes) {
      setToast({ kind: "error", message: "ファイルの読み込みに失敗しました" });
      return;
    }
    // Confirmed files are now editable (they act as the "master" org chart).
    // Edit access is solely a function of accessForVersion(); the FIX label
    // doesn't lock edits any more — only an explicit 確定解除 reverts to draft.
    setViewOnly(!canEdit);
    replaceNodes(nodes, { versionId: id, versionLabel: name });
    // After a successful load, collapse the drawer so the editor canvas
    // is fully visible — this is the whole reason the drawer exists.
    setFilesDrawerOpen(false);
    if (isConfirmed && canEdit) {
      setToast({
        kind: "info",
        message: "確定版（マスター）を開きました。編集して保存すると確定版のまま更新されます。",
      });
    } else if (!canEdit) {
      setToast({
        kind: "info",
        message: "閲覧のみのファイルを開きました（編集は無効）",
      });
    }
  }

  async function handleDuplicate(id: string, sourceName: string, e: React.MouseEvent) {
    e.stopPropagation();
    const author = getAuthor() ?? currentUser?.display_name ?? "";
    const dupName = window.prompt(
      "複製したファイルの名前を入力してください",
      `${sourceName} のコピー`,
    );
    if (dupName === null) return;
    const trimmed = dupName.trim();
    if (!trimmed) {
      setToast({ kind: "error", message: "ファイル名を入力してください" });
      return;
    }
    const row = await duplicate(id, trimmed, author, currentUser?.email ?? null);
    if (!row) {
      setToast({ kind: "error", message: "複製に失敗しました" });
      return;
    }
    if (dirty) {
      setToast({
        kind: "info",
        message: `「${trimmed}」を作成しました（下書きタブから開けます）`,
      });
      setTab("draft");
      return;
    }
    const nodes = await getSnapshot(row.id);
    if (nodes) {
      setViewOnly(false);
      replaceNodes(nodes, { versionId: row.id, versionLabel: row.name });
    }
    setTab("draft");
    setToast({ kind: "info", message: `「${trimmed}」を複製しました` });
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const { id, name } = pendingDelete;
    setPendingDelete(null);
    const success = await remove(id);
    setToast(
      success
        ? { kind: "info", message: `「${name}」を削除しました` }
        : { kind: "error", message: "削除に失敗しました" },
    );
  }

  async function commitFix(period: string) {
    if (!pendingFix) return;
    const { id } = pendingFix;
    setPendingFix(null);
    const ok = await setConfirmation(id, {
      is_confirmed: true,
      confirmed_period: period,
    });
    setToast(
      ok
        ? { kind: "info", message: `「${period}」の確定版として登録しました` }
        : { kind: "error", message: "FIX登録に失敗しました" },
    );
    if (ok) setTab("confirmed");
  }

  async function commitRename(newName: string) {
    if (!pendingRename) return;
    const { id, name: oldName } = pendingRename;
    const trimmed = newName.trim();
    if (!trimmed) {
      setToast({ kind: "error", message: "ファイル名を入力してください" });
      return;
    }
    if (trimmed === oldName) {
      setPendingRename(null);
      return;
    }
    setPendingRename(null);
    const ok = await rename(id, trimmed);
    if (ok) {
      // If the file being renamed is the one currently loaded in the editor,
      // sync the header label so the user sees the new name immediately.
      if (currentVersionId === id) setCurrentVersionLabel(trimmed);
      setToast({ kind: "info", message: `ファイル名を「${trimmed}」に変更しました` });
    } else {
      setToast({ kind: "error", message: "名称変更に失敗しました" });
    }
  }

  async function unfix(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await setConfirmation(id, {
      is_confirmed: false,
      confirmed_period: null,
    });
    setToast(
      ok
        ? { kind: "info", message: "下書きに戻しました" }
        : { kind: "error", message: "下書きへの差し戻しに失敗しました" },
    );
  }

  async function togglePrivate(id: string, current: boolean, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = await updatePermissions(id, { is_private: !current });
    setToast(
      ok
        ? {
            kind: "info",
            message: !current
              ? "🔒 非公開にしました（作成者のみ閲覧・編集可能）"
              : "🔓 公開に戻しました",
          }
        : { kind: "error", message: "公開設定の更新に失敗しました" },
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="versions">
        <header className="versions__header">
          <h2 className="sidebar__title" style={{ margin: 0 }}>組織図ファイル</h2>
        </header>
        <p className="versions__empty">
          サーバ未設定です。<code>VITE_SUPABASE_URL</code> と
          <code>VITE_SUPABASE_ANON_KEY</code> を設定してください。
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="versions">
        <header className="versions__header">
          <h2 className="sidebar__title" style={{ margin: 0 }}>組織図ファイル</h2>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => refresh()}
            title="一覧を再読み込み"
          >
            ↻
          </button>
        </header>

        {currentUser?.role !== "viewer" && (
          <button
            className="btn btn--primary"
            onClick={() => setShowSave(true)}
            title="現在の組織図を新しいファイルとしてサーバに保存"
          >
            ＋新規ファイルとして保存
          </button>
        )}

        {error && <p className="versions__error">{error}</p>}

        <div className="versions__tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "draft"}
            className={`versions__tab ${tab === "draft" ? "is-active" : ""}`}
            onClick={() => setTab("draft")}
          >
            下書き <span className="versions__tabCount">{draftList.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === "confirmed"}
            className={`versions__tab ${tab === "confirmed" ? "is-active" : ""}`}
            onClick={() => setTab("confirmed")}
          >
            確定版 <span className="versions__tabCount">{confirmedList.length}</span>
          </button>
        </div>

        <div className="versions__list">
          {loading && tabList.length === 0 && (
            <p className="versions__empty">読み込み中…</p>
          )}
          {!loading && tabList.length === 0 && versions.length === 0 && (
            <p className="versions__empty">
              保存済みファイルはまだありません。
              <br />
              「＋新規ファイルとして保存」から最初の一件を作成してください。
            </p>
          )}
          {!loading && tabList.length === 0 && versions.length > 0 && (
            <p className="versions__empty">
              {tab === "confirmed"
                ? "確定版はまだありません。下書きの「確定」ボタンから確定版にしてください。"
                : "下書きはまだありません。"}
            </p>
          )}
          {tabList.map(({ v, access }) => {
            const isActive = currentVersionId === v.id;
            const isPrivate = !!v.is_private;
            const isCreator = !!v.created_by_email && v.created_by_email === currentUser?.email;
            const canDelete = currentUser?.role === "master" || isCreator;
            const canConfirm =
              currentUser?.role === "master" || currentUser?.role === "editor";
            // Only the creator (or master) can flip the privacy lock — same
            // people who already have edit-rights to the file metadata.
            const canToggleLock = currentUser?.role === "master" || isCreator;
            const canRename = currentUser?.role === "master" || isCreator;

            return (
              <div
                key={v.id}
                className={`version-card ${isActive ? "is-active" : ""} ${v.is_confirmed ? "is-confirmed" : ""} ${isPrivate ? "is-private" : ""}`}
                onClick={() => handleLoad(v.id, v.name, access.edit, !!v.is_confirmed)}
                role="button"
                tabIndex={0}
                title={fullDateTime(v.created_at)}
              >
                <div className="version-card__head">
                  <span className="version-card__name">
                    {v.is_confirmed && (
                      <span className="version-card__period" title="確定版">
                        {formatPeriod(v.confirmed_period)}
                      </span>
                    )}
                    {v.name}
                  </span>
                  {!access.edit && !v.is_confirmed && (
                    <span
                      className="version-card__readonly"
                      title="このファイルに対しては閲覧権限のみあります"
                    >
                      閲覧のみ
                    </span>
                  )}
                </div>
                <div className="version-card__meta">
                  <span className="version-card__author">{v.author}</span>
                  <span className="version-card__sep">·</span>
                  <span className="version-card__time">
                    {v.updated_at && v.updated_at !== v.created_at
                      ? `更新 ${timeAgo(v.updated_at)}`
                      : timeAgo(v.created_at)}
                  </span>
                </div>
                {v.note && <div className="version-card__note">{v.note}</div>}
                {isActive && <div className="version-card__active">読み込み中</div>}

                <div className="version-card__menu">
                  {canToggleLock && (
                    <button
                      className={`vmenu__btn ${isPrivate ? "is-on" : ""}`}
                      onClick={(e) => togglePrivate(v.id, isPrivate, e)}
                      title={
                        isPrivate
                          ? "現在『非公開』です — クリックで全員に公開"
                          : "鍵をかけて非公開にする（作成者とマスターのみ閲覧・編集可）"
                      }
                    >
                      <span className="vmenu__icon" aria-hidden>{isPrivate ? "🔒" : "🔓"}</span>
                      <span className="vmenu__label">{isPrivate ? "非公開" : "公開中"}</span>
                    </button>
                  )}
                  {canRename && (
                    <button
                      className="vmenu__btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingRename({ id: v.id, name: v.name });
                      }}
                      title="ファイル名を変更"
                    >
                      <span className="vmenu__icon" aria-hidden>✏️</span>
                      <span className="vmenu__label">名称変更</span>
                    </button>
                  )}
                  {currentUser?.role !== "viewer" && (
                    <button
                      className="vmenu__btn"
                      onClick={(e) => handleDuplicate(v.id, v.name, e)}
                      title={
                        v.is_confirmed
                          ? "確定版を元に下書きを作成して編集を始める"
                          : "このファイルを複製して新しい下書きを作成"
                      }
                    >
                      <span className="vmenu__icon" aria-hidden>📋</span>
                      <span className="vmenu__label">複製</span>
                    </button>
                  )}
                  {canConfirm && !v.is_confirmed && (
                    <button
                      className="vmenu__btn vmenu__btn--accent"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingFix({ id: v.id, name: v.name });
                      }}
                      title="このファイルを月次の確定版として登録"
                    >
                      <span className="vmenu__icon" aria-hidden>✓</span>
                      <span className="vmenu__label">確定登録</span>
                    </button>
                  )}
                  {canConfirm && v.is_confirmed && (
                    <button
                      className="vmenu__btn"
                      onClick={(e) => unfix(v.id, e)}
                      title="確定を取り消して下書きに戻す"
                    >
                      <span className="vmenu__icon" aria-hidden>↺</span>
                      <span className="vmenu__label">確定解除</span>
                    </button>
                  )}
                  {canDelete && (
                    <button
                      className="vmenu__btn vmenu__btn--danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPendingDelete({ id: v.id, name: v.name });
                      }}
                      title="ファイルを削除"
                    >
                      <span className="vmenu__icon" aria-hidden>🗑</span>
                      <span className="vmenu__label">削除</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {showSave && <SaveVersionDialog onClose={() => setShowSave(false)} />}
      {pendingDelete && (
        <DeleteVersionModal
          name={pendingDelete.name}
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
      {pendingFix && (
        <FixDialog
          versionName={pendingFix.name}
          onCancel={() => setPendingFix(null)}
          onConfirm={commitFix}
        />
      )}
      {pendingRename && (
        <RenameDialog
          currentName={pendingRename.name}
          onCancel={() => setPendingRename(null)}
          onConfirm={commitRename}
        />
      )}
    </>
  );
}

function RenameDialog({
  currentName,
  onCancel,
  onConfirm,
}: {
  currentName: string;
  onCancel: () => void;
  onConfirm: (newName: string) => void;
}) {
  const [name, setName] = useState(currentName);
  const trimmed = name.trim();
  const unchanged = trimmed === currentName;
  const canSubmit = trimmed.length > 0 && !unchanged;

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">ファイル名を変更</h3>
        <p className="modal__body">
          現在の名前: <strong>「{currentName}」</strong>
        </p>
        <label className="field">
          <span className="field__label">新しいファイル名</span>
          <input
            className="field__input"
            type="text"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSubmit) onConfirm(trimmed);
              if (e.key === "Escape") onCancel();
            }}
          />
        </label>
        <div className="modal__actions" style={{ marginTop: 14 }}>
          <button className="btn btn--ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onConfirm(trimmed)}
            disabled={!canSubmit}
          >
            変更する
          </button>
        </div>
      </div>
    </div>
  );
}

function formatPeriod(period: string | null | undefined): string {
  if (!period) return "";
  const m = /^(\d{4})-(\d{1,2})/.exec(period);
  if (!m) return period;
  return `${m[1]}年${parseInt(m[2], 10)}月度`;
}

function FixDialog({
  versionName,
  onCancel,
  onConfirm,
}: {
  versionName: string;
  onCancel: () => void;
  onConfirm: (period: string) => void;
}) {
  const todayMonth = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  const [period, setPeriod] = useState(todayMonth);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">確定版として登録</h3>
        <p className="modal__body">
          <strong>「{versionName}」</strong>{" "}
          を月次の確定版として登録します。年月を選んでください。
        </p>
        <label className="field">
          <span className="field__label">対象年月</span>
          <input
            className="field__input"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
          />
          <span className="field__value" style={{ marginTop: 4 }}>
            表示：{formatPeriod(period)}
          </span>
        </label>
        <div className="modal__actions" style={{ marginTop: 14 }}>
          <button className="btn btn--ghost" onClick={onCancel}>
            キャンセル
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onConfirm(period)}
            disabled={!period}
          >
            確定版として登録
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Hold-to-confirm delete dialog. We replaced the type-to-confirm flow because
 * the user found retyping names friction-y; the press-and-hold gesture keeps
 * accidental clicks safe while being faster on the common case.
 */
function DeleteVersionModal({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">ファイルを削除</h3>
        <p className="modal__body">
          ファイル <strong>「{name}」</strong> を完全に削除します。
          <br />
          この操作は取り消せません。
        </p>
        <p className="modal__body" style={{ marginTop: 6, fontSize: 12, color: "var(--text-muted)" }}>
          下のバーを <strong>1秒間 押し続ける</strong> と削除されます。
        </p>
        <HoldToConfirm
          label="押し続けて削除"
          variant="danger"
          autoFocus
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}
