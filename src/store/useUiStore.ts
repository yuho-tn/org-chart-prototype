import { create } from "zustand";

export type OrgView = "tree" | "list";
/**
 * Top-level pages of the app. We don't pull in a routing library — there
 * are only two views and we want the URL hash to reflect which one is
 * active so browser back/forward and reload still land in the right place.
 */
export type Route =
  | { name: "editor" }
  | { name: "employees" }
  | { name: "announcements" }
  | { name: "announcement"; id: string };

function readRouteFromHash(): Route {
  if (typeof window === "undefined") return { name: "editor" };
  const h = window.location.hash;
  if (h === "" || h === "#" || h === "#/") return { name: "editor" };
  if (h === "#/employees") return { name: "employees" };
  if (h === "#/announcements") return { name: "announcements" };
  const m = /^#\/announcements\/([0-9a-f-]+)$/i.exec(h);
  if (m) return { name: "announcement", id: m[1] };
  return { name: "editor" };
}

function routeToHash(r: Route): string {
  switch (r.name) {
    case "editor":
      return "";
    case "employees":
      return "#/employees";
    case "announcements":
      return "#/announcements";
    case "announcement":
      return `#/announcements/${r.id}`;
  }
}

function writeRouteToHash(r: Route) {
  if (typeof window === "undefined") return;
  const next = routeToHash(r);
  if (window.location.hash !== next) {
    if (next === "") {
      window.history.pushState(null, "", window.location.pathname + window.location.search);
    } else {
      window.location.hash = next.slice(1);
    }
  }
}

type UiState = {
  view: OrgView;
  /** True when the page is opened via a `?v=` share URL — editing is disabled. */
  viewOnly: boolean;
  /** Label shown in the viewer header for the loaded shared version. */
  sharedVersionLabel: string | null;
  /** Operation-history drawer open state. Defaults closed; shown via TopBar button. */
  showLog: boolean;
  /** User management modal open state. */
  showUsers: boolean;
  /** Top-level route. */
  route: Route;
  setView: (v: OrgView) => void;
  setViewOnly: (b: boolean) => void;
  setSharedVersionLabel: (label: string | null) => void;
  setShowLog: (b: boolean) => void;
  setShowUsers: (b: boolean) => void;
  /** Navigate. Pass `pushHistory: false` to update the URL without a new history entry. */
  navigate: (r: Route, opts?: { pushHistory?: boolean }) => void;
};

export const useUiStore = create<UiState>((set) => ({
  view: "tree",
  viewOnly: false,
  sharedVersionLabel: null,
  showLog: false,
  showUsers: false,
  route: readRouteFromHash(),
  setView: (view) => set({ view }),
  setViewOnly: (viewOnly) => set({ viewOnly }),
  setSharedVersionLabel: (sharedVersionLabel) => set({ sharedVersionLabel }),
  setShowLog: (showLog) => set({ showLog }),
  setShowUsers: (showUsers) => set({ showUsers }),
  navigate: (route, opts) => {
    set({ route });
    if (opts?.pushHistory === false) {
      const hash = routeToHash(route);
      const next =
        window.location.pathname + window.location.search + hash;
      window.history.replaceState(null, "", next);
    } else {
      writeRouteToHash(route);
    }
  },
}));

// Keep state and URL hash in sync when the user uses browser back / forward.
if (typeof window !== "undefined") {
  window.addEventListener("hashchange", () => {
    const next = readRouteFromHash();
    if (useUiStore.getState().route !== next) {
      useUiStore.setState({ route: next });
    }
  });
}
