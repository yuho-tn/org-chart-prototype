import { useEffect, useState } from "react";
import { getAuthor, setAuthor } from "../lib/author";
import { useAuthStore } from "../store/useAuthStore";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * Bootstrap / sign-in flow. Two layered concerns:
 *
 *   1. Display name (legacy) — saved versions show this as "作成者". Stored
 *      in localStorage via lib/author.ts.
 *   2. Email identity (new) — keys the user record in app_users. Used for
 *      per-version permission checks. Stored in localStorage by useAuthStore.
 *
 * On first launch (no email yet) we ask for both. We then ensure the email
 * exists in app_users:
 *   • If app_users is empty: register the new email as 'master' (bootstrap).
 *   • If the email already exists: sign in.
 *   • If users exist but the entered email is unknown: reject with a hint
 *     ("マスターに登録を依頼してください") — we do NOT auto-create non-master
 *     users; that's the master's job via the user-management modal.
 */
export function AuthorPrompt({ onReady }: { onReady: () => void }) {
  const refreshUsers = useAuthStore((s) => s.refresh);
  const setCurrentEmail = useAuthStore((s) => s.setCurrentEmail);
  const addUser = useAuthStore((s) => s.addUser);
  const usersInitialized = useAuthStore((s) => s.initialized);
  const users = useAuthStore((s) => s.users);
  const currentEmail = useAuthStore((s) => s.currentEmail);
  const error = useAuthStore((s) => s.error);

  const [name, setName] = useState(getAuthor() ?? "");
  const [email, setEmail] = useState(currentEmail ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  // Bootstrap: refresh the users list once on mount so we can decide
  // whether to allow the first-master register flow.
  useEffect(() => {
    if (isSupabaseConfigured) refreshUsers();
  }, [refreshUsers]);

  const ready =
    !!getAuthor() &&
    !!currentEmail &&
    users.some((u) => u.email === currentEmail);

  useEffect(() => {
    if (ready) onReady();
  }, [ready, onReady]);

  if (ready) return null;
  // Wait for the users list before showing the form so we know whether we're
  // in the bootstrap (empty users → register-as-master) state.
  if (isSupabaseConfigured && !usersInitialized) {
    return (
      <div className="modal-backdrop">
        <div className="modal">
          <p className="modal__body">読み込み中…</p>
        </div>
      </div>
    );
  }

  const isBootstrap = users.length === 0;

  async function submit() {
    setLocalError(null);
    const trimmedName = name.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !trimmedEmail) return;
    if (!trimmedEmail.includes("@")) {
      setLocalError("メールアドレスの形式が正しくありません");
      return;
    }
    setSubmitting(true);
    try {
      setAuthor(trimmedName);
      setCurrentEmail(trimmedEmail);

      if (!isSupabaseConfigured) {
        // No backend — accept anything, the app runs in localStorage-only mode.
        onReady();
        return;
      }

      const existing = users.find((u) => u.email === trimmedEmail);
      if (existing) {
        // Already registered — just refresh so currentUser resolves.
        await refreshUsers();
        return;
      }

      if (isBootstrap) {
        // First user becomes master.
        const res = await addUser({
          email: trimmedEmail,
          display_name: trimmedName,
          role: "master",
        });
        if (!res.ok) {
          setLocalError(res.reason ?? "登録に失敗しました");
          return;
        }
        return;
      }

      // Users exist but this email isn't one of them.
      setLocalError(
        "このメールアドレスは登録されていません。マスター権限を持つユーザーに、ユーザー管理画面から追加してもらってください。",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 480 }}>
        <h3 className="modal__title">
          {isBootstrap ? "初期セットアップ：マスターユーザーの登録" : "サインイン"}
        </h3>
        <p className="modal__body">
          {isBootstrap ? (
            <>
              このSupabaseプロジェクトではまだユーザーが登録されていません。最初に登録するユーザーは
              <strong>マスター権限</strong>
              （すべてのバージョンを閲覧・編集できる）になります。
            </>
          ) : (
            <>
              登録済みのメールアドレスでサインインしてください。
              未登録の場合はマスターのユーザーに依頼してください。
            </>
          )}
        </p>
        <label className="field" style={{ marginBottom: 10 }}>
          <span className="field__label">表示名</span>
          <input
            className="field__input"
            autoFocus
            placeholder="例：丹野 裕鵬"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field" style={{ marginBottom: 12 }}>
          <span className="field__label">メールアドレス</span>
          <input
            className="field__input"
            type="email"
            placeholder="example@company.co.jp"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </label>
        {(localError || error) && (
          <p className="versions__error" style={{ marginBottom: 12 }}>
            {localError ?? error}
          </p>
        )}
        <div className="modal__actions">
          <button
            className="btn btn--primary"
            disabled={!name.trim() || !email.trim() || submitting}
            onClick={submit}
          >
            {submitting ? "確認中…" : isBootstrap ? "マスターとして登録" : "サインイン"}
          </button>
        </div>
      </div>
    </div>
  );
}
