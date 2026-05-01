import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import type { AppUserRole } from "../lib/supabase";

const ROLE_OPTIONS: { value: AppUserRole; label: string; hint: string }[] = [
  {
    value: "master",
    label: "マスター",
    hint: "すべてのバージョン（非公開含む）を閲覧・編集できる",
  },
  {
    value: "editor",
    label: "編集",
    hint: "非公開でない・または明示的に許可されたバージョンを閲覧・編集",
  },
  {
    value: "viewer",
    label: "閲覧",
    hint: "閲覧のみ。編集はできない",
  },
];

export function UserManagementModal() {
  const open = useUiStore((s) => s.showUsers);
  const setOpen = useUiStore((s) => s.setShowUsers);
  const users = useAuthStore((s) => s.users);
  const currentUser = useAuthStore((s) => s.currentUser);
  const refresh = useAuthStore((s) => s.refresh);
  const addUser = useAuthStore((s) => s.addUser);
  const removeUser = useAuthStore((s) => s.removeUser);
  const setUserRole = useAuthStore((s) => s.setUserRole);
  const error = useAuthStore((s) => s.error);
  const setToast = useOrgStore((s) => s.setToast);

  const [draftEmail, setDraftEmail] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftRole, setDraftRole] = useState<AppUserRole>("editor");
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const isMaster = currentUser?.role === "master";

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      // Master(s) first, then editors, then viewers; tie-break by created_at.
      const order: Record<AppUserRole, number> = { master: 0, editor: 1, viewer: 2 };
      const d = order[a.role] - order[b.role];
      if (d !== 0) return d;
      return a.created_at.localeCompare(b.created_at);
    });
  }, [users]);

  if (!open) return null;

  function close() {
    setPendingRemove(null);
    setOpen(false);
  }

  async function submitNew() {
    if (!draftEmail.trim() || !draftName.trim()) return;
    setBusy(true);
    const res = await addUser({
      email: draftEmail.trim(),
      display_name: draftName.trim(),
      role: draftRole,
    });
    setBusy(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "登録に失敗しました" });
      return;
    }
    setDraftEmail("");
    setDraftName("");
    setDraftRole("editor");
    setToast({ kind: "info", message: "ユーザーを追加しました" });
  }

  async function changeRole(email: string, role: AppUserRole) {
    const ok = await setUserRole(email, role);
    if (ok) setToast({ kind: "info", message: "権限を更新しました" });
  }

  async function confirmRemove() {
    if (!pendingRemove) return;
    const email = pendingRemove;
    setPendingRemove(null);
    const res = await removeUser(email);
    setToast(
      res.ok
        ? { kind: "info", message: "ユーザーを削除しました" }
        : { kind: "error", message: res.reason ?? "削除に失敗しました" },
    );
  }

  return (
    <>
      <div className="modal-backdrop" onClick={close}>
        <div
          className="modal modal--wide"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="modal__title">ユーザー管理</h3>
          <p className="modal__body">
            登録されたメールアドレスのみがこのツールにアクセスできます。
            権限はバージョンごとの公開設定とあわせて閲覧・編集の可否を決定します。
          </p>

          {error && (
            <p className="versions__error" style={{ marginBottom: 10 }}>
              {error}
            </p>
          )}

          <table className="usermgr__table">
            <thead>
              <tr>
                <th>メールアドレス</th>
                <th>表示名</th>
                <th>権限</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="usermgr__empty">
                    まだユーザーが登録されていません。
                  </td>
                </tr>
              )}
              {sortedUsers.map((u) => {
                const isSelf = currentUser?.email === u.email;
                return (
                  <tr key={u.email}>
                    <td>
                      <code>{u.email}</code>
                      {isSelf && <span className="usermgr__self">（自分）</span>}
                    </td>
                    <td>{u.display_name ?? "—"}</td>
                    <td>
                      {isMaster && !isSelf ? (
                        <select
                          className="field__input"
                          value={u.role}
                          onChange={(e) => changeRole(u.email, e.target.value as AppUserRole)}
                        >
                          {ROLE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`usermgr__role usermgr__role--${u.role}`}>
                          {ROLE_OPTIONS.find((o) => o.value === u.role)?.label ?? u.role}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {isMaster && !isSelf && (
                        <button
                          className="btn btn--ghost btn--xs"
                          onClick={() => setPendingRemove(u.email)}
                          title="このユーザーを削除"
                        >
                          削除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {isMaster ? (
            <div className="usermgr__add">
              <h4 className="usermgr__addTitle">＋新規ユーザーを追加</h4>
              <div className="usermgr__addRow">
                <input
                  className="field__input"
                  placeholder="email@example.com"
                  value={draftEmail}
                  onChange={(e) => setDraftEmail(e.target.value)}
                  type="email"
                />
                <input
                  className="field__input"
                  placeholder="表示名"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                />
                <select
                  className="field__input"
                  value={draftRole}
                  onChange={(e) => setDraftRole(e.target.value as AppUserRole)}
                >
                  {ROLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn--primary"
                  disabled={busy || !draftEmail.trim() || !draftName.trim()}
                  onClick={submitNew}
                >
                  追加
                </button>
              </div>
              <ul className="usermgr__roleHints">
                {ROLE_OPTIONS.map((opt) => (
                  <li key={opt.value}>
                    <strong>{opt.label}</strong>：{opt.hint}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="modal__body" style={{ fontSize: 12, color: "var(--text-muted)" }}>
              ユーザーの追加・削除・権限変更はマスター権限を持つユーザーのみが行えます。
            </p>
          )}

          <div className="modal__actions">
            <button className="btn" onClick={close}>
              閉じる
            </button>
          </div>
        </div>
      </div>
      {pendingRemove && (
        <div className="modal-backdrop" onClick={() => setPendingRemove(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal__title">ユーザー削除の確認</h3>
            <p className="modal__body">
              <code>{pendingRemove}</code> を削除します。<br />
              このユーザーが作成した非公開バージョンは、マスター以外からは見えなくなります。
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={() => setPendingRemove(null)}>
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
