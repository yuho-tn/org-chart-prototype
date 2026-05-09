import { useEffect, useState } from "react";
import { useAuthStore } from "../store/useAuthStore";
import { isSupabaseConfigured } from "../lib/supabase";

/**
 * Full-screen sign-in surface shown whenever the app boots without an
 * authenticated Supabase session. Single Google button — domain
 * restriction (sho-san.co.jp) is enforced both client-side via the
 * hd= query param and server-side via the on_auth_user_created trigger.
 *
 * After the user clicks "Googleでサインイン", the browser navigates to
 * accounts.google.com and back to /; detectSessionInUrl picks up the
 * fragment, useAuthStore.initialize() observes the new session, and
 * App.tsx unmounts this component automatically.
 */
export function SignInPage() {
  const signInWithGoogle = useAuthStore((s) => s.signInWithGoogle);
  const error = useAuthStore((s) => s.error);
  const loading = useAuthStore((s) => s.loading);
  const [hashError, setHashError] = useState<string | null>(null);

  // Surface OAuth callback errors. Supabase appends ?error_description=...
  // to the redirect URL when the trigger raises (e.g. domain rejected).
  useEffect(() => {
    const url = new URL(window.location.href);
    const desc =
      url.searchParams.get("error_description") ||
      new URLSearchParams(url.hash.replace(/^#/, "")).get("error_description");
    if (desc) {
      setHashError(decodeURIComponent(desc));
      // Strip the params so the message doesn't linger across reloads.
      window.history.replaceState({}, "", url.pathname);
    }
  }, []);

  return (
    <div className="signin">
      <div className="signin__card">
        <div className="signin__brand">
          <span className="signin__brandMark" aria-hidden>▣</span>
          <span className="signin__brandName">TalentHub</span>
        </div>
        <h1 className="signin__title">サインイン</h1>
        <p className="signin__lead">
          組織図 &amp; 従業員管理ツールにアクセスするには、社内のGoogleアカウントでサインインしてください。
        </p>

        {!isSupabaseConfigured && (
          <p className="signin__error">
            Supabaseが設定されていません。`.env` で `VITE_SUPABASE_URL` と `VITE_SUPABASE_ANON_KEY` を設定してください。
          </p>
        )}

        <button
          className="signin__google"
          onClick={() => signInWithGoogle()}
          disabled={!isSupabaseConfigured || loading}
        >
          <span className="signin__googleIcon" aria-hidden>
            {/* Inline Google G — kept simple to avoid a logo asset */}
            <svg viewBox="0 0 18 18" width="18" height="18">
              <path
                fill="#4285F4"
                d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.79 2.72v2.26h2.9c1.7-1.57 2.69-3.88 2.69-6.63z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.8.54-1.83.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.95 10.7a5.4 5.4 0 0 1 0-3.4V4.97H.96a9 9 0 0 0 0 8.07l2.99-2.34z"
              />
              <path
                fill="#EA4335"
                d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58A8.97 8.97 0 0 0 9 0 9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"
              />
            </svg>
          </span>
          <span>{loading ? "サインイン中…" : "Googleでサインイン"}</span>
        </button>

        <p className="signin__hint">
          <strong>sho-san.co.jp</strong> ドメインのアカウントのみアクセスできます。
          初回サインイン時は閲覧者（viewer）として登録され、管理者からの権限昇格をお待ちください。
        </p>

        {(hashError || error) && (
          <p className="signin__error">{hashError ?? error}</p>
        )}
      </div>
    </div>
  );
}
