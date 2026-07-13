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
  | "home"
  | "org"
  | "employees"
  | "missions"
  | "survey"
  | "pulse"
  | "reviews"
  | "ailevel"
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
  | { name: "home" }
  // editor: 組織図ファイル1枚を開いている状態。versionId 付き = そのファイルの
  // ディープリンク（#/org/<id>・共有可能）。versionId 無し = #/org（ブランク）。
  | { name: "editor"; versionId?: string }
  | { name: "announcements" }
  | { name: "announcement"; id: string }
  | { name: "employees" }
  | { name: "employee"; num: string }
  | { name: "users" }
  | { name: "permissions" }
  // P2: ミッションシート
  | { name: "missions" }
  | { name: "mission_templates" }
  | { name: "mission_template"; id: string }
  | { name: "mission_sheet"; id: string }
  // パルスサーベイ 回答画面（chrome 無し・ログイン必須のディープリンク）
  | { name: "survey" }
  // パルスサーベイ 管理ダッシュボード（chrome 内・権限者）
  | { name: "pulse" }
  // パルスサーベイ メンバー別回答推移（P4-①・実名閲覧権限者のみ・section は "pulse" と共通）
  | { name: "pulse_members" }
  | { name: "pulse_member"; num: string }
  // パルスサーベイ アラート一覧＋対応管理（section は "pulse" と共通・サブナビ切替）
  | { name: "pulse_alerts" }
  // パルスサーベイ コメント一覧（section は "pulse" と共通・サブナビ切替）
  | { name: "pulse_comments" }
  // パルスサーベイ 設定（質問セット/設問/サイクル・section は "pulse" と共通）
  | { name: "pulse_admin" }
  // 人事評価制度（静的コンテンツ・全ログインユーザー閲覧可。section は共通 "reviews"）
  | { name: "reviews" }
  | { name: "reviews_rank" }
  | { name: "reviews_grade" }
  | { name: "reviews_flow" }
  | { name: "reviews_rules" }
  // AI活用レベル（分布=全ログインユーザー可視。section は共通 "ailevel"）
  | { name: "ailevel" }
  // AIレベル 認定管理（管理者のみ・ページ側でゲート）
  | { name: "ailevel_admin" }
  // Payroll
  | { name: "salary" }
  | { name: "grades" }
  | { name: "audit_log" };

export function sectionOfRoute(r: Route): Section {
  switch (r.name) {
    case "home":
      return "home";
    case "editor":
    case "announcements":
    case "announcement":
      return "org";
    case "employees":
    case "employee":
      return "employees";
    case "missions":
    case "mission_templates":
    case "mission_template":
    case "mission_sheet":
      return "missions";
    case "survey":
      return "survey";
    case "pulse":
    case "pulse_members":
    case "pulse_member":
    case "pulse_alerts":
    case "pulse_comments":
    case "pulse_admin":
      return "pulse";
    case "reviews":
    case "reviews_rank":
    case "reviews_grade":
    case "reviews_flow":
    case "reviews_rules":
      return "reviews";
    case "ailevel":
    case "ailevel_admin":
      return "ailevel";
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
    case "home":
      return { name: "home" };
    case "org":
      return { name: "editor" };
    case "employees":
      return { name: "employees" };
    case "missions":
      return { name: "missions" };
    case "survey":
      return { name: "survey" };
    case "pulse":
      return { name: "pulse" };
    case "reviews":
      return { name: "reviews" };
    case "ailevel":
      return { name: "ailevel" };
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
  return s === "payroll" ? { name: "salary" } : { name: "home" };
}

function readRouteFromHash(): Route {
  if (typeof window === "undefined") return { name: "home" };
  const h = window.location.hash;
  // TOP は「ホーム」。組織図は #/org に退避（旧来の TOP=組織図から分離）。
  if (h === "" || h === "#" || h === "#/") return { name: "home" };
  if (h === "#/org" || h === "#/editor") return { name: "editor" };
  // 組織図ファイルのディープリンク: #/org/<versionId>（org_versions の uuid）
  const org = /^#\/org\/([0-9a-f-]+)$/i.exec(h);
  if (org) return { name: "editor", versionId: org[1] };
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
  // P2: ミッションシート（system="talenthub"）
  if (h === "#/missions") return { name: "missions" };
  if (h === "#/missions/templates") return { name: "mission_templates" };
  const mt = /^#\/missions\/templates\/([0-9a-f-]+)$/i.exec(h);
  if (mt) return { name: "mission_template", id: mt[1] };
  const msh = /^#\/missions\/sheet\/([0-9a-f-]+)$/i.exec(h);
  if (msh) return { name: "mission_sheet", id: msh[1] };
  // パルスサーベイ 回答画面
  if (h === "#/survey") return { name: "survey" };
  // パルスサーベイ 管理ダッシュボード / メンバー / アラート / コメント
  const pmem = /^#\/pulse\/members\/([^/]+)$/.exec(h);
  if (pmem) {
    try {
      return { name: "pulse_member", num: decodeURIComponent(pmem[1]) };
    } catch {
      return { name: "pulse_members" };
    }
  }
  if (h === "#/pulse/members") return { name: "pulse_members" };
  if (h === "#/pulse/alerts") return { name: "pulse_alerts" };
  if (h === "#/pulse/comments") return { name: "pulse_comments" };
  if (h === "#/pulse/admin") return { name: "pulse_admin" };
  if (h === "#/pulse") return { name: "pulse" };
  // 人事評価制度
  if (h === "#/reviews") return { name: "reviews" };
  if (h === "#/reviews/rank") return { name: "reviews_rank" };
  if (h === "#/reviews/grade") return { name: "reviews_grade" };
  if (h === "#/reviews/flow") return { name: "reviews_flow" };
  if (h === "#/reviews/rules") return { name: "reviews_rules" };
  // AI活用レベル
  if (h === "#/ailevel") return { name: "ailevel" };
  if (h === "#/ailevel/admin") return { name: "ailevel_admin" };
  // Payroll routes
  if (h === "#/payroll" || h === "#/payroll/salary") return { name: "salary" };
  if (h === "#/payroll/grades") return { name: "grades" };
  if (h === "#/payroll/audit-log") return { name: "audit_log" };
  return { name: "home" };
}

function routeToHash(r: Route): string {
  switch (r.name) {
    case "home":
      return "";
    case "editor":
      return r.versionId ? `#/org/${r.versionId}` : "#/org";
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
    case "missions":
      return "#/missions";
    case "mission_templates":
      return "#/missions/templates";
    case "mission_template":
      return `#/missions/templates/${r.id}`;
    case "mission_sheet":
      return `#/missions/sheet/${r.id}`;
    case "survey":
      return "#/survey";
    case "pulse":
      return "#/pulse";
    case "pulse_members":
      return "#/pulse/members";
    case "pulse_member":
      return `#/pulse/members/${encodeURIComponent(r.num)}`;
    case "pulse_alerts":
      return "#/pulse/alerts";
    case "pulse_comments":
      return "#/pulse/comments";
    case "pulse_admin":
      return "#/pulse/admin";
    case "reviews":
      return "#/reviews";
    case "reviews_rank":
      return "#/reviews/rank";
    case "reviews_grade":
      return "#/reviews/grade";
    case "reviews_flow":
      return "#/reviews/flow";
    case "reviews_rules":
      return "#/reviews/rules";
    case "ailevel":
      return "#/ailevel";
    case "ailevel_admin":
      return "#/ailevel/admin";
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
