import { useEffect, useMemo, useState } from "react";
import { useAuthStore, isUserManager } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import { ConfirmDialog } from "./ConfirmDialog";
import type { AppUserRole } from "../lib/supabase";

const ROLE_OPTIONS: { value: AppUserRole; label: string; hint: string }[] = [
  {
    value: "master",
    label: "マスター",
    hint: "最上位。すべての組織図ファイル（非公開含む）と給与・査定を閲覧・編集でき、全ユーザーの権限を変更できる唯一のロール。特権管理者・管理者への任命もできる（固定：yuho_tn@sho-san.co.jp）",
  },
  {
    value: "privileged_admin",
    label: "特権管理者",
    hint: "すべての組織図ファイルを閲覧・編集 + 給与・査定を閲覧・編集 + ユーザー管理（管理者・編集・閲覧まで任命可）。※特権管理者・マスターへの昇格はできない（給与アクセスの付与はマスター専任）",
  },
  {
    value: "admin",
    label: "管理者",
    hint: "すべての組織図ファイルを閲覧・編集 + ユーザー管理（管理者・編集・閲覧まで任命可）。給与・査定にはアクセスできない",
  },
  {
    value: "editor",
    label: "編集",
    hint: "非公開でない、または明示的に許可されたファイルのみ閲覧・編集。ユーザー管理・給与にはアクセスできない",
  },
  {
    value: "viewer",
    label: "閲覧",
    hint: "閲覧のみ。編集はできない（初回サインイン時のデフォルト）",
  },
];

/** Capability matrix rendered as a table in the 権限について card so each
 *  role's scope is explicit at a glance. Kept in sync with ROLE_OPTIONS
 *  hints and the RLS in migrations 0011 / 0015 / 0017 / 0021. */
const CAPABILITY_ROWS: {
  role: AppUserRole;
  org: string;
  users: string;
  payroll: string;
  assign: string;
}[] = [
  { role: "master", org: "全ファイル編集", users: "○ 全員", payroll: "閲覧・編集", assign: "特権管理者／管理者／編集／閲覧" },
  { role: "privileged_admin", org: "全ファイル編集", users: "○（管理者以下）", payroll: "閲覧・編集", assign: "管理者／編集／閲覧" },
  { role: "admin", org: "全ファイル編集", users: "○（管理者以下）", payroll: "×", assign: "管理者／編集／閲覧" },
  { role: "editor", org: "許可分のみ編集", users: "×", payroll: "×", assign: "—" },
  { role: "viewer", org: "閲覧のみ", users: "×", payroll: "×", assign: "—" },
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
  // 「管理者以上」= master / privileged_admin / admin。DB 側は migration
  // 0021 の RLS（is_user_admin + WITH CHECK の上限キャップ）が同じ制約を
  // 二重で担保する。
  const canManage = isUserManager(currentUser?.role);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const order: Record<AppUserRole, number> = {
        master: 0,
        privileged_admin: 1,
        admin: 2,
        editor: 3,
        viewer: 4,
      };
      const d = order[a.role] - order[b.role];
      if (d !== 0) return d;
      return a.created_at.localeCompare(b.created_at);
    });
  }, [users]);

  /** Who each operator may edit/remove (containment model, migration 0021):
   *   • master: everyone except the master row itself (self is also blocked
   *     below; there is only ever one master).
   *   • privileged_admin / admin: only rows at 管理者以下 (admin/editor/
   *     viewer) — they must not touch a master or another privileged_admin,
   *     which keeps 給与アクセス out of their reach. */
  function canEditUser(target: { email: string; role: AppUserRole }): boolean {
    if (!canManage) return false;
    if (currentUser?.email === target.email) return false;
    if (isMaster) return target.role !== "master";
    // privileged_admin / admin: capped at 管理者以下
    return (
      target.role === "admin" ||
      target.role === "editor" ||
      target.role === "viewer"
    );
  }

  /** Roles an operator may assign. Master can grant anything below master
   *  (master itself is DB-fixed to yuho_tn@sho-san.co.jp). privileged_admin
   *  and admin are capped at 管理者以下 — granting 特権管理者/マスター
   *  (＝給与アクセス) stays master-only. Mirrored by the RLS WITH CHECK. */
  function assignableRoles(): AppUserRole[] {
    if (isMaster) return ["privileged_admin", "admin", "editor", "viewer"];
    if (currentUser?.role === "privileged_admin" || currentUser?.role === "admin")
      return ["admin", "editor", "viewer"];
    return [];
  }

  async function submitNew() {
    const email = draftEmail.trim().toLowerCase();
    const name = draftName.trim();
    if (!email || !name) return;
    if (!email.endsWith("@sho-san.co.jp")) {
      setToast({
        kind: "error",
        message: "@sho-san.co.jp ドメインのメールアドレスのみ登録できます",
      });
      return;
    }
    setBusy(true);
    const res = await addUser({
      email,
      display_name: name,
      role: draftRole,
    });
    setBusy(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "登録に失敗しました" });
      return;
    }
    setDraftEmail("");
    setDraftName("");
    setDraftRole(assignableRoles()[0] ?? "editor");
    setToast({
      kind: "info",
      message: `${email} を ${ROLE_OPTIONS.find((o) => o.value === draftRole)?.label ?? draftRole} 権限で登録しました（初回サインイン時に有効化されます）`,
    });
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
            <strong>管理者以上（管理者・特権管理者・マスター）</strong>
            は、このページから権限を昇格／降格させてください。
          </p>

          <div className="card__body--flush" style={{ overflowX: "auto", marginBottom: 16 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>ロール</th>
                  <th>組織図ファイル</th>
                  <th>ユーザー管理</th>
                  <th>給与・査定</th>
                  <th>任命できる権限</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITY_ROWS.map((r) => (
                  <tr key={r.role}>
                    <td>
                      <span className={`usermgr__role usermgr__role--${r.role}`}>
                        {ROLE_OPTIONS.find((o) => o.value === r.role)?.label ?? r.role}
                      </span>
                    </td>
                    <td>{r.org}</td>
                    <td>{r.users}</td>
                    <td>{r.payroll}</td>
                    <td>{r.assign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="usermgr__roleHints">
            {ROLE_OPTIONS.map((opt) => (
              <li key={opt.value}>
                <strong>{opt.label}</strong>：{opt.hint}
              </li>
            ))}
          </ul>
          <p className="page__hint" style={{ marginTop: 12 }}>
            ※ <strong>特権管理者</strong>（給与・査定にアクセスできるロール）
            と <strong>マスター</strong> への昇格は、給与情報アクセスの拡散を
            防ぐためマスターのみが行えます。管理者・特権管理者が任命できるのは
            「管理者」までです。
          </p>
          {!canManage && (
            <p className="page__hint" style={{ marginTop: 12 }}>
              権限の変更はマスター・特権管理者・管理者のみが行えます。
            </p>
          )}
        </div>
      </section>

      {/* Pre-provision: master/admin can register a sho-san.co.jp user
          ahead of their first login with a chosen role. The trigger's
          ON CONFLICT DO UPDATE preserves the role on first sign-in, so
          the user lands directly with the assigned permissions instead
          of starting as viewer and waiting for a manual upgrade. */}
      {canManage && (
        <section className="card" style={{ marginTop: 20 }}>
          <header className="card__head">
            <h2 className="card__title">ユーザーを事前登録</h2>
            <span className="card__sub">
              次回サインイン時から指定の権限で利用できます
            </span>
          </header>
          <div className="card__body">
            <p className="page__hint" style={{ marginTop: 0, marginBottom: 12 }}>
              <strong>@sho-san.co.jp</strong> のメールアドレスをここで登録しておくと、
              そのユーザーが初めてGoogleサインインしたタイミングで指定した権限で参加できます。
              事前登録しなかったユーザーは「閲覧」権限で自動登録されます。
            </p>
            <div className="usermgr__addRow">
              <input
                className="field__input"
                placeholder="user@sho-san.co.jp"
                value={draftEmail}
                onChange={(e) => setDraftEmail(e.target.value)}
                type="email"
              />
              <input
                className="field__input"
                placeholder="表示名（例：山田 太郎）"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
              />
              <select
                className="field__input"
                value={draftRole}
                onChange={(e) => setDraftRole(e.target.value as AppUserRole)}
              >
                {assignableRoles().map((value) => (
                  <option key={value} value={value}>
                    {ROLE_OPTIONS.find((o) => o.value === value)?.label ?? value}
                  </option>
                ))}
              </select>
              <button
                className="btn btn--primary"
                disabled={busy || !draftEmail.trim() || !draftName.trim()}
                onClick={submitNew}
              >
                登録
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
