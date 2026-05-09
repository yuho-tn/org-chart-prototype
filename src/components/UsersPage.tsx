import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import { ConfirmDialog } from "./ConfirmDialog";
import type { AppUserRole } from "../lib/supabase";

const ROLE_OPTIONS: { value: AppUserRole; label: string; hint: string }[] = [
  {
    value: "master",
    label: "マスター",
    hint: "すべてのファイル（非公開含む）を閲覧・編集 + ユーザー管理（master固定はyuho_tn@forumyu.co.jpのみ）",
  },
  {
    value: "admin",
    label: "管理者",
    hint: "すべてのファイルを閲覧・編集 + ユーザー権限の昇格／降格が可能",
  },
  {
    value: "editor",
    label: "編集",
    hint: "非公開でない、または明示的に許可されたファイルを閲覧・編集",
  },
  {
    value: "viewer",
    label: "閲覧",
    hint: "閲覧のみ。編集はできない（初回サインイン時のデフォルト）",
  },
];

/**
 * Full-page user management view (was previously a modal).
 * Lives at the top-level "ユーザー" section of the global header.
 */
export function UsersPage() {
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
    refresh();
  }, [refresh]);

  const isMaster = currentUser?.role === "master";
  const canManage = currentUser?.role === "master" || currentUser?.role === "admin";

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const order: Record<AppUserRole, number> = { master: 0, admin: 1, editor: 2, viewer: 3 };
      const d = order[a.role] - order[b.role];
      if (d !== 0) return d;
      return a.created_at.localeCompare(b.created_at);
    });
  }, [users]);

  /** Admins can manage editors and viewers, but not other admins or the
   *  master. Master can manage everyone except themselves (the trigger
   *  ensures the master row stays as 'master' on every login anyway). */
  function canEditUser(target: { email: string; role: AppUserRole }): boolean {
    if (!canManage) return false;
    if (currentUser?.email === target.email) return false;
    if (isMaster) return target.role !== "master" || target.email !== "yuho_tn@forumyu.co.jp";
    // admin
    return target.role === "editor" || target.role === "viewer";
  }

  /** Roles an admin/master can assign. Master can assign any role except
   *  re-promote to master (master is fixed to yuho_tn@forumyu.co.jp).
   *  Admins can only set editor/viewer. */
  function assignableRoles(): AppUserRole[] {
    if (isMaster) return ["admin", "editor", "viewer"];
    if (currentUser?.role === "admin") return ["editor", "viewer"];
    return [];
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
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">ユーザー</h1>
          <p className="page__subtitle">
            このツールにアクセスできるユーザーを管理します。
            権限はファイル単位の公開設定とあわせて閲覧・編集の可否を決定します。
          </p>
        </div>
      </div>

      {error && <p className="versions__error" style={{ marginBottom: 16 }}>{error}</p>}

      <section className="card">
        <header className="card__head">
          <h2 className="card__title">登録ユーザー</h2>
          <span className="card__sub">{sortedUsers.length}名</span>
        </header>
        <div className="card__body card__body--flush">
          <table className="data-table">
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
                  <td colSpan={4} className="data-table__empty">
                    まだユーザーが登録されていません。
                  </td>
                </tr>
              )}
              {sortedUsers.map((u) => {
                const isSelf = currentUser?.email === u.email;
                const editable = canEditUser(u);
                const opts = assignableRoles();
                // Show the user's current role even if it's outside what
                // the operator can assign — they shouldn't be able to
                // demote/promote past their own ceiling.
                const optList = opts.includes(u.role) ? opts : [u.role, ...opts];
                return (
                  <tr key={u.email}>
                    <td>
                      <code>{u.email}</code>
                      {isSelf && <span className="usermgr__self">（自分）</span>}
                    </td>
                    <td>{u.display_name ?? "—"}</td>
                    <td>
                      {editable ? (
                        <select
                          className="field__input field__input--inline"
                          value={u.role}
                          onChange={(e) => changeRole(u.email, e.target.value as AppUserRole)}
                        >
                          {optList.map((value) => (
                            <option key={value} value={value}>
                              {ROLE_OPTIONS.find((o) => o.value === value)?.label ?? value}
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
                      {editable && (
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
        </div>
      </section>

      <section className="card" style={{ marginTop: 20 }}>
        <header className="card__head">
          <h2 className="card__title">権限について</h2>
        </header>
        <div className="card__body">
          <p className="page__hint" style={{ marginTop: 0, marginBottom: 12 }}>
            ユーザーは <strong>sho-san.co.jp ドメインのGoogleアカウント</strong>
            でサインインすると自動的に「閲覧」権限で登録されます。
            管理者・マスターは、このページから権限を昇格／降格させてください。
          </p>
          <ul className="usermgr__roleHints">
            {ROLE_OPTIONS.map((opt) => (
              <li key={opt.value}>
                <strong>{opt.label}</strong>：{opt.hint}
              </li>
            ))}
          </ul>
          {!canManage && (
            <p className="page__hint" style={{ marginTop: 12 }}>
              権限の変更はマスターまたは管理者のみが行えます。
            </p>
          )}
        </div>
      </section>

      {/* Manual user creation is no longer needed (auto-provisioned on
          first sign-in) but kept in code for emergencies — only master
          can use it, hidden from admins. */}
      {isMaster && false && (
        <section className="card" style={{ marginTop: 20 }}>
          <header className="card__head">
            <h2 className="card__title">手動でユーザーを追加（緊急用）</h2>
          </header>
          <div className="card__body">
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
          </div>
        </section>
      )}

      {pendingRemove && (
        <ConfirmDialog
          title="ユーザー削除の確認"
          message={
            <>
              <code>{pendingRemove}</code> を削除します。<br />
              このユーザーが作成した非公開ファイルは、マスター以外からは見えなくなります。
            </>
          }
          confirmLabel="削除する"
          variant="danger"
          onConfirm={confirmRemove}
          onCancel={() => setPendingRemove(null)}
        />
      )}
    </main>
  );
}
