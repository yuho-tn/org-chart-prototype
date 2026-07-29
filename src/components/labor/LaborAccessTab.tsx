import { useEffect, useState } from "react";
import { useLaborAccessStore, type LaborRole } from "../../store/useLaborAccessStore";
import { useAuthStore } from "../../store/useAuthStore";

/**
 * アクセス管理タブ（owner 限定表示）。
 * 人件費管理へアクセスできるメールアドレスを owner/viewer で追加・削除・変更する。
 *  - owner  … データ閲覧 ＋ このリスト編集
 *  - viewer … データ閲覧のみ
 * DB 側で「owner を0人にする操作」は必ず失敗する（ロックアウト防止）。
 */

const roleLabel: Record<LaborRole, string> = { owner: "管理者", viewer: "閲覧者" };

export function LaborAccessTab() {
  const admins = useLaborAccessStore((s) => s.admins);
  const loading = useLaborAccessStore((s) => s.loading);
  const busy = useLaborAccessStore((s) => s.busy);
  const error = useLaborAccessStore((s) => s.error);
  const loadAdmins = useLaborAccessStore((s) => s.loadAdmins);
  const addAdmin = useLaborAccessStore((s) => s.addAdmin);
  const removeAdmin = useLaborAccessStore((s) => s.removeAdmin);
  const updateRole = useLaborAccessStore((s) => s.updateRole);
  const myEmail = useAuthStore((s) => s.session?.user?.email ?? "").toLowerCase();

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<LaborRole>("viewer");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    void loadAdmins();
  }, [loadAdmins]);

  const ownerCount = admins.filter((a) => a.role === "owner").length;

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    if (kind === "ok") setTimeout(() => setMsg(null), 2500);
  };

  const onAdd = async () => {
    const r = await addAdmin(email, role);
    if (r.ok) {
      flash("ok", `${email.trim().toLowerCase()} を「${roleLabel[role]}」で追加しました。`);
      setEmail("");
      setRole("viewer");
    } else {
      flash("err", r.reason ?? "追加に失敗しました。");
    }
  };

  const onRemove = async (targetEmail: string) => {
    if (!window.confirm(`${targetEmail} のアクセス権を削除します。よろしいですか？`)) return;
    const r = await removeAdmin(targetEmail);
    if (r.ok) flash("ok", `${targetEmail} を削除しました。`);
    else flash("err", r.reason ?? "削除に失敗しました。");
  };

  const onChangeRole = async (targetEmail: string, next: LaborRole) => {
    const r = await updateRole(targetEmail, next);
    if (r.ok) flash("ok", `${targetEmail} を「${roleLabel[next]}」に変更しました。`);
    else flash("err", r.reason ?? "変更に失敗しました。");
  };

  return (
    <div className="labor-access">
      <div className="labor-access-intro">
        <h2>アクセス管理</h2>
        <p className="labor-hint">
          人件費管理を開けるメンバーを管理します。<strong>管理者</strong>はデータ閲覧に加えてこのリストを編集でき、
          <strong>閲覧者</strong>はデータ閲覧のみです。給与という機微データのため、追加は最小限にしてください。
        </p>
      </div>

      {/* 追加フォーム */}
      <div className="labor-access-add">
        <input
          className="labor-access-input"
          type="email"
          inputMode="email"
          placeholder="メールアドレス（例: name@sho-san.co.jp）"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && email.trim()) void onAdd(); }}
          disabled={busy}
        />
        <select
          className="labor-select"
          value={role}
          onChange={(e) => setRole(e.target.value as LaborRole)}
          disabled={busy}
        >
          <option value="viewer">閲覧者</option>
          <option value="owner">管理者</option>
        </select>
        <button className="labor-btn labor-btn--on" onClick={() => void onAdd()} disabled={busy || !email.trim()}>
          追加
        </button>
      </div>

      {msg && (
        <div className={msg.kind === "ok" ? "labor-access-msg labor-access-msg--ok" : "labor-access-msg labor-access-msg--err"}>
          {msg.text}
        </div>
      )}
      {error && <div className="labor-warn">読み込みエラー: {error}</div>}

      {/* 一覧 */}
      <table className="labor-access-table">
        <thead>
          <tr>
            <th>メールアドレス</th>
            <th>権限</th>
            <th className="labor-access-actions">操作</th>
          </tr>
        </thead>
        <tbody>
          {loading && admins.length === 0 ? (
            <tr><td colSpan={3} className="labor-access-empty">読み込み中…</td></tr>
          ) : admins.length === 0 ? (
            <tr><td colSpan={3} className="labor-access-empty">登録なし</td></tr>
          ) : (
            admins.map((a) => {
              const isMe = a.email === myEmail;
              const isLastOwner = a.role === "owner" && ownerCount <= 1;
              return (
                <tr key={a.email}>
                  <td>
                    {a.email}
                    {isMe && <span className="labor-access-you">あなた</span>}
                  </td>
                  <td>
                    <select
                      className="labor-select"
                      value={a.role}
                      disabled={busy || isLastOwner}
                      title={isLastOwner ? "最後の管理者は降格できません" : undefined}
                      onChange={(e) => void onChangeRole(a.email, e.target.value as LaborRole)}
                    >
                      <option value="owner">管理者</option>
                      <option value="viewer">閲覧者</option>
                    </select>
                  </td>
                  <td className="labor-access-actions">
                    <button
                      className="labor-access-del"
                      onClick={() => void onRemove(a.email)}
                      disabled={busy || isLastOwner}
                      title={isLastOwner ? "最後の管理者は削除できません" : undefined}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      <p className="labor-note">
        管理者 {ownerCount}名 ／ 全{admins.length}名。最後の管理者は削除・降格できません（ロックアウト防止）。
      </p>
    </div>
  );
}
