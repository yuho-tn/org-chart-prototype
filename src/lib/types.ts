export type NodeKind = "department" | "person";

export type DeptCategory = "ROOT" | "Exe" | "DIV" | "TM" | "Unit" | "DEPT";

/**
 * Role label shown in a person chip's "leader" strip when present.
 * Null/undefined means a regular member.
 *
 * The "Cxx" prefixed entries (CDM/CTM/CTL) are "チャレンジ" variants — same
 * level of management as the un-prefixed counterpart but flagged as a stretch
 * assignment. They get a slightly different chip color so they're easy to
 * spot in a chart review.
 */
export type PersonRole =
  | "CEO"
  | "COO"
  | "CTO"
  | "CFO"
  | "CHRO"
  | "CMO"
  | "DM"
  | "CDM"
  | "TM"
  | "CTM"
  | "TL"
  | "CTL"
  | "UL"
  | null;

/** Roles that mark a person as an executive (役員) by default. */
export const EXECUTIVE_ROLES: ReadonlyArray<NonNullable<PersonRole>> = [
  "CEO",
  "COO",
  "CTO",
  "CFO",
  "CHRO",
  "CMO",
];

/** Display order for dropdowns / pickers — top-down by seniority. */
export const ALL_ROLES: ReadonlyArray<NonNullable<PersonRole>> = [
  "CEO",
  "COO",
  "CTO",
  "CFO",
  "CHRO",
  "CMO",
  "DM",
  "CDM",
  "TM",
  "CTM",
  "TL",
  "CTL",
  "UL",
];

/** Long-form Japanese description for each role, used in dropdown labels. */
export const ROLE_DESCRIPTIONS: Record<NonNullable<PersonRole>, string> = {
  CEO: "最高経営責任者",
  COO: "最高執行責任者",
  CTO: "最高技術責任者",
  CFO: "最高財務責任者",
  CHRO: "最高人事責任者",
  CMO: "最高マーケティング責任者",
  DM: "DIVマネージャー",
  CDM: "チャレンジDIVマネージャー",
  TM: "TMマネージャー",
  CTM: "チャレンジTMマネージャー",
  TL: "TMリーダー",
  CTL: "チャレンジTMリーダー",
  UL: "Unitリーダー",
};

/** "Challenge" variants get a distinct visual treatment vs the base role. */
export const CHALLENGE_ROLES: ReadonlyArray<NonNullable<PersonRole>> = [
  "CDM",
  "CTM",
  "CTL",
];

export function roleLabel(role: NonNullable<PersonRole>): string {
  return `${role}（${ROLE_DESCRIPTIONS[role]}）`;
}

export type OrgNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parentId: string | null;
  /** dept-only: visual sub-category */
  category?: DeptCategory;
  /** dept-only: index into the color palette */
  colorIndex?: number;
  /** person-only: leader role; null/absent means regular member */
  roleLabel?: PersonRole;
  /** person-only: when true, render in the executive band (parent=ROOT) or with an exec badge inside a dept card */
  isExecutive?: boolean;
  /** when true, this node has been created but not yet placed in the tree — it lives in the left tray until the user drags it onto the canvas. */
  isUnplaced?: boolean;
  /**
   * person-only: optional foreign key into the public.employees master.
   * When set, this person node represents a specific registered employee —
   * used to compute "unplaced employees" per version (i.e. employees on the
   * roster who are NOT yet referenced by any node in the current chart).
   */
  employeeNumber?: string;
};

export type LogEntry = {
  id: string;
  ts: number;
  action: "add" | "delete" | "rename" | "move" | "reset" | "save" | "role" | "restore";
  detail: string;
  /**
   * Snapshot of `nodes` taken BEFORE this operation was performed. Lets the
   * log panel act as a Google Sheets-style revision history: clicking
   * "復元" on an entry rewinds the tree to this snapshot.
   * Optional because some legacy entries (or trivially restorable states)
   * may omit it.
   */
  snapshotBefore?: OrgNode[];
};

export type AppState = {
  nodes: OrgNode[];
  selectedId: string | null;
  log: LogEntry[];
  toast: { kind: "info" | "error"; message: string } | null;
};
