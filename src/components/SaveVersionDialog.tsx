import { useEffect, useMemo, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useAuthStore } from "../store/useAuthStore";
import { getAuthor } from "../lib/author";
import type { VersionGrants } from "../lib/supabase";

function defaultName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SaveVersionDialog({ onClose }: { onClose: () => void }) {
  const nodes = useOrgStore((s) => s.nodes);
  const markClean = useOrgStore((s) => s.markClean);
  const setToast = useOrgStore((s) => s.setToast);
  const save = useVersionsStore((s) => s.save);
  const currentUser = useAuthStore((s) => s.currentUser);
  const users = useAuthStore((s) => s.users);

  const [name, setName] = useState(defaultName());
  const [note, setNote] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [grants, setGrants] = useState<VersionGrants>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const author = getAuthor() ?? "";
  const currentEmail = currentUser?.email ?? null;

  // The creator always has full access; we don't surface them in the grant
  // picker since "edit" is implicit.
  const eligibleUsers = useMemo(
    () => users.filter((u) => u.email !== currentEmail),
    [users, currentEmail],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function setGrant(email: string, level: "" | "view" | "edit") {
    setGrants((prev) => {
      const next = { ...prev };
      if (level === "") delete next[email];
      else next[email] = level;
      return next;
    });
  }

  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const row = await save({
      name: name.trim(),
      author,
      note: note.trim() || null,
      nodes,
      created_by_email: currentEmail,
      is_private: isPrivate,
      grants,
    });
    setSubmitting(false);
    if (!row) {
      setError("保存に失敗しました。ネットワーク／設定をご確認ください。");
      return;
    }
    markClean({ versionId: row.id, versionLabel: row.name, rev: row.rev ?? 0 });
    setToast({ kind: "info", message: `バージョン「${row.name}」を保存しました` });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal--wide"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="modal__title">新規ファイルとして保存</h3>
        <p className="modal__body" style={{ margin: "0 0 12px" }}>
          現在の組織図を新しいファイルとしてサーバに保存します。
          後で開き直すと、このファイルを上書き保存しながら編集できます。
        </p>

        <label className="field">
          <span className="field__label">ファイル名（必須）</span>
          <input
            className="field__input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：2026春・新体制／検討案A"
          />
        </label>

        <label className="field" style={{ marginTop: 10 }}>
          <span className="field__label">メモ（任意）</span>
          <textarea
            className="field__input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="このバージョンで何を変更したかなど"
          />
        </label>

        <div className="field" style={{ marginTop: 10 }}>
          <span className="field__label">作成者</span>
          <span className="field__value">
            {author || "（未設定）"} {currentEmail && <code>（{currentEmail}）</code>}
          </span>
        </div>

        <fieldset className="versionperms">
          <legend className="field__label">公開設定</legend>
          <label className="checkbox" style={{ alignItems: "center" }}>
            <input
              type="checkbox"
              checked={isPrivate}
              onChange={(e) => setIsPrivate(e.target.checked)}
            />
            <span>
              <strong>非公開</strong>
              ：自分（と「マスター」権限のユーザー）のみ閲覧可能。下の許可リストに追加した相手だけ個別に閲覧／編集を許可できます。
            </span>
          </label>
        </fieldset>

        <fieldset className="versionperms">
          <legend className="field__label">
            個別の閲覧・編集許可（{isPrivate ? "非公開バージョン用" : "編集権の付与用"}）
          </legend>
          {eligibleUsers.length === 0 ? (
            <p
              className="modal__body"
              style={{ fontSize: 12, color: "var(--text-muted)", margin: 0 }}
            >
              他に登録されたユーザーがいません。
            </p>
          ) : (
            <div className="versionperms__grid">
              {eligibleUsers.map((u) => {
                const cur = grants[u.email] ?? "";
                return (
                  <div key={u.email} className="versionperms__row">
                    <span className="versionperms__user">
                      {u.display_name ?? "—"}
                      <code>{u.email}</code>
                      <span className={`usermgr__role usermgr__role--${u.role}`}>{u.role}</span>
                    </span>
                    <select
                      className="field__input"
                      value={cur}
                      onChange={(e) =>
                        setGrant(u.email, e.target.value as "" | "view" | "edit")
                      }
                    >
                      <option value="">{isPrivate ? "アクセス不可" : "（標準）"}</option>
                      <option value="view">閲覧のみ</option>
                      <option value="edit">編集も可</option>
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </fieldset>

        {error && (
          <p style={{ color: "var(--danger)", fontSize: 12, margin: "10px 0 0" }}>{error}</p>
        )}

        <div className="modal__actions" style={{ marginTop: 16 }}>
          <button className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            キャンセル
          </button>
          <button
            className="btn btn--primary"
            onClick={submit}
            disabled={!name.trim() || !author || submitting}
          >
            {submitting ? "保存中…" : "保存する"}
          </button>
        </div>
      </div>
    </div>
  );
}
