import { useAuthStore } from "../store/useAuthStore";

/**
 * Returns the human-readable name to attribute saves to. Now derived from
 * the live Supabase Auth session (post-0008 OAuth migration) instead of a
 * localStorage prompt; legacy callers — ConfirmedBanner, save dialogs —
 * keep working unchanged.
 *
 * Preference order:
 *   1. app_users.display_name (admin-curated label)
 *   2. session.user.user_metadata.name (Google profile name)
 *   3. session.user.email
 */
export function getAuthor(): string | null {
  const state = useAuthStore.getState();
  const u = state.currentUser;
  if (u?.display_name) return u.display_name;
  const sessUser = state.session?.user;
  if (sessUser) {
    const meta = sessUser.user_metadata as { name?: string; full_name?: string } | undefined;
    return meta?.name ?? meta?.full_name ?? sessUser.email ?? null;
  }
  return null;
}

// Legacy no-ops kept so existing call sites compile without churn.
// Author identity is now owned by the Supabase Auth session and the
// app_users row, not localStorage.
export function setAuthor(_name: string): void {
  // intentionally empty — see module doc
}

export function clearAuthor(): void {
  // intentionally empty — see module doc
}
