import type { OrgView } from "../store/useUiStore";

export type ShareParams = {
  versionId: string | null;
  view: OrgView;
};

export function parseShareParams(): ShareParams {
  const params = new URLSearchParams(window.location.search);
  const versionId = params.get("v");
  const viewParam = params.get("view") as OrgView | null;
  // When the sharer picked a view explicitly (?view=), always honor it.
  // Otherwise default to the tree on desktop, but to the list on phones —
  // a pan/zoom canvas is unreadable on a narrow screen, whereas the
  // indented list reads top-to-bottom without gestures. The tree tab is
  // still one tap away.
  const explicit =
    viewParam === "list" || viewParam === "assignments" || viewParam === "tree";
  const isNarrow =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 640px)").matches;
  const view: OrgView = explicit ? viewParam! : isNarrow ? "list" : "tree";
  return { versionId, view };
}

export function buildShareUrl(versionId: string, view: OrgView = "tree"): string {
  const url = new URL(window.location.href);
  url.search = "";
  // Clear the hash too: since files are now routed as #/org/<id>, a share
  // link generated while a file is open would otherwise carry a stale
  // "#/org/<id>" tail (harmless for the read-only viewer, but confusing).
  url.hash = "";
  url.searchParams.set("v", versionId);
  if (view !== "tree") url.searchParams.set("view", view);
  return url.toString();
}

/**
 * Anonymous, no-login share link for an HR announcement. Uses `?a=<token>`
 * (distinct from the org-chart `?v=`) so the boot logic can route it to the
 * read-only announcement viewer. The token gates access via a SECURITY
 * DEFINER RPC — the hr_announcements table itself stays anon-locked.
 */
export function parseAnnouncementShareToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("a");
}

export function buildAnnouncementShareUrl(token: string): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("a", token);
  return url.toString();
}

export function clearShareParamsFromUrl(): void {
  const url = new URL(window.location.href);
  url.search = "";
  window.history.replaceState({}, "", url.toString());
}

/**
 * Reflect the currently-loaded file in the browser address bar by writing
 * `?v=<id>` (or removing it when the file is unloaded). Preserves the rest
 * of the URL — pathname and hash-based view routing are left untouched —
 * so users can copy the address bar to share whatever file is on screen.
 *
 * Uses replaceState (no history entry) because file switches inside the
 * SPA aren't navigations the user expects in their back-button stack.
 */
export function syncVersionUrlParam(versionId: string | null): void {
  const url = new URL(window.location.href);
  const current = url.searchParams.get("v");
  if (versionId) {
    if (current === versionId) return;
    url.searchParams.set("v", versionId);
  } else {
    if (current === null && !url.searchParams.has("view")) return;
    url.searchParams.delete("v");
    // The legacy share URL also carried `view=` — strip it together so we
    // don't leave a stale partial param behind when unloading.
    url.searchParams.delete("view");
  }
  window.history.replaceState({}, "", url.toString());
}
