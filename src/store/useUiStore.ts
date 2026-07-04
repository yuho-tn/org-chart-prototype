import { create } from "zustand";

export type OrgView = "tree" | "list" | "assignments";

/**
 * Top-level "system" axis. Above the GlobalHeader sits a small system
 * switcher; choosing a system swaps the entire app shell (header tabs,
 * color theme, available sections). TalentHub is the original org/HR
 * tooling; Payroll is the 給与・査定 system added in 0011+.
 *
 * Payroll is only visible to master / privileged_admin (canAccessPayroll
 * in lib/supabase). Routing here is unconditional — the UI gates the
 * switcher button and App.tsx redirects on direct-hash access.
 */
export type SystemKey = "talenthub" | "payroll";

/**
 * Primary navigation sections, shown as the top-tier of the global header
 * within each system.
 *   TalentHub: org / employees / users / permissions
 *   Payroll:   salary / grades / audit_log
 */
export type Section =
  | "org"
  | "employees"
  | "users"
  | "permissions"
  | "salary"
  | "grades"
  | "audit_log";

/**
 * Concrete routes. Most routes belong to exactly one section — see
 * sectionOfRoute(). We don't pull in a routing library; the URL hash
 * reflects which page is active so browser back/forward and reload land
 * in the right place.
 */
export type Route =
  // TalentHub
  | { name: "editor" }
  | { name: "announcements" }
  | { name: "announcement"; id: string }
  | { name: "employees" }
  | { name: "employee"; num: string }
  | { name: "users" }
  | { name: "permissions" }
  // Payroll
  | { name: "salary" }
  | { name: "grades" }
  | { name: "audit_log" };

export function sectionOfRoute(r: Route): Section {
  switch (r.name) {
    case "editor":
    case "announcements":
    case "announcement":
      return "org";
    case "employees":
    case "employee":
      return "employees";
    case "users":
      return "users";
    case "permissions":
      return "permissions";
    case "salary":
      return "salary";
    case "grades":
      return "grades";
    case "audit_log":
      return "audit_log";
  }
}

export function systemOfRoute(r: Route): SystemKey {
  switch (r.name) {
    case "salary":
    case "grades":
    case "audit_log":
      return "payroll";
    default:
      return "talenthub";
  }
}

/** Default landing route for a section when the user clicks its primary tab. */
export function defaultRouteForSection(s: Section): Route {
  switch (s) {
    case "org":
      return { name: "editor" };
    case "employees":
      return { name: "employees" };
    case "users":
      return { name: "users" };
    case "permissions":
      return { name: "permissions" };
    case "salary":
      return { name: "salary" };
    case "grades":
      return { name: "grades" };
    case "audit_log":
      return { name: "audit_log" };
  }
}

/** Default landing route when switching to a system. */
export function defaultRouteForSystem(s: SystemKey): Route {
  return s === "payroll" ? { name: "salary" } : { name: "editor" };
}

function readRouteFromHash(): Route {
  if (typeof window === "undefined") return { name: "editor" };
  const h = window.location.hash;
  if (h === "" || h === "#" || h === "#/") return { name: "editor" };
  if (h === "#/employees") return { name: "employees" };
  if (h === "#/users") return { name: "users" };
  if (h === "#/permissions") return { name: "permissions" };
  if (h === "#/announcements") return { name: "announcements" };
  const m = /^#\/announcements\/([0-9a-f-]+)$/i.exec(h);
  if (m) return { name: "announcement", id: m[1] };
  // 従業員詳細: #/employees/:num（社員番号はURLエンコードされている想定）
  const emp = /^#\/employees\/([^/]+)$/.exec(h);
  if (emp) {
    try {
      return { name: "employee", num: decodeURIComponent(emp[1]) };
    } catch {
      // 不正な %xx シーケンス（URIError）は一覧へフォールバック
      return { name: "employees" };
    }
  }
  // Payroll routes
  if (h === "#/payroll" || h === "#/payroll/salary") return { name: "salary" };
  if (h === "#/payroll/grades") return { name: "grades" };
  if (h === "#/payroll/audit-log") return { name: "audit_log" };
  return { name: "editor" };
}

function routeToHash(r: Route): string {
  switch (r.name) {
    case "editor":
      return "";
    case "employees":
      return "#/employees";
    case "employee":
      return `#/employees/${encodeURIComponent(r.num)}`;
    case "users":
      return "#/users";
    case "permissions":
      return "#/permissions";
    case "announcements":
      return "#/announcements";
    case "announcement":
      return `#/announcements/${r.id}`;
    case "salary":
      return "#/payroll";
    case "grades":
      return "#/payroll/grades";
    case "audit_log":
      return "#/payroll/audit-log";
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
  /** Files drawer open state — slides in from the left when the user clicks
   *  the ファイル button in OrgSubNav. Auto-closes when a file is loaded. */
  filesDrawerOpen: boolean;
  /** Top-level route. */
  route: Route;
  /** True for ~300ms after a system switch — used to drive a cross-fade. */
  systemSwitching: boolean;
  setView: (v: OrgView) => void;
  setViewOnly: (b: boolean) => void;
  setSharedVersionLabel: (label: string | null) => void;
  setShowLog: (b: boolean) => void;
  setFilesDrawerOpen: (b: boolean) => void;
  /** Navigate. Pass `pushHistory: false` to update the URL without a new history entry. */
  navigate: (r: Route, opts?: { pushHistory?: boolean }) => void;
  /** Switch to another system's default route with a short fade. */
  switchSystem: (s: SystemKey) => void;
};

const SYSTEM_FADE_MS = 300;

export const useUiStore = create<UiState>((set, get) => ({
  view: "tree",
  viewOnly: false,
  sharedVersionLabel: null,
  showLog: false,
  filesDrawerOpen: false,
  route: readRouteFromHash(),
  systemSwitching: false,
  setView: (view) => set({ view }),
  setViewOnly: (viewOnly) => set({ viewOnly }),
  setSharedVersionLabel: (sharedVersionLabel) => set({ sharedVersionLabel }),
  setShowLog: (showLog) => set({ showLog }),
  setFilesDrawerOpen: (filesDrawerOpen) => set({ filesDrawerOpen }),
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
  switchSystem: (s) => {
    const current = systemOfRoute(get().route);
    if (current === s) return;
    set({ systemSwitching: true });
    get().navigate(defaultRouteForSystem(s));
    window.setTimeout(() => set({ systemSwitching: false }), SYSTEM_FADE_MS);
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
