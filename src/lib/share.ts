import type { OrgView } from "../store/useUiStore";

export type ShareParams = {
  versionId: string | null;
  view: OrgView;
};

export function parseShareParams(): ShareParams {
  const params = new URLSearchParams(window.location.search);
  const versionId = params.get("v");
  const viewParam = params.get("view") as OrgView | null;
  const view: OrgView =
    viewParam === "list" || viewParam === "assignments" || viewParam === "tree"
      ? viewParam
      : "tree";
  return { versionId, view };
}

export function buildShareUrl(versionId: string, view: OrgView = "tree"): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("v", versionId);
  if (view !== "tree") url.searchParams.set("view", view);
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
