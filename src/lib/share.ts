import type { OrgView } from "../store/useUiStore";

export type ShareParams = {
  versionId: string | null;
  view: OrgView;
};

export function parseShareParams(): ShareParams {
  const params = new URLSearchParams(window.location.search);
  const versionId = params.get("v");
  const viewParam = params.get("view") as OrgView | null;
  return {
    versionId,
    view: viewParam === "list" ? "list" : "tree",
  };
}

export function buildShareUrl(versionId: string, view: OrgView = "tree"): string {
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("v", versionId);
  if (view === "list") url.searchParams.set("view", "list");
  return url.toString();
}

export function clearShareParamsFromUrl(): void {
  const url = new URL(window.location.href);
  url.search = "";
  window.history.replaceState({}, "", url.toString());
}
