export type NodeKind = "department" | "person";

export type DeptCategory = "ROOT" | "Exe" | "DIV" | "TM" | "Unit" | "DEPT";

/**
 * Role label shown in a person chip's "leader" strip when present.
 * Null/undefined means a regular member.
 */
export type PersonRole =
  | "CEO"
  | "COO"
  | "CFO"
  | "CTO"
  | "CMO"
  | "CHRO"
  | "DM"
  | "TM"
  | "UL"
  | "CTL"
  | "TL"
  | null;

/** Roles that mark a person as an executive (役員) by default. */
export const EXECUTIVE_ROLES: ReadonlyArray<NonNullable<PersonRole>> = [
  "COO",
  "CFO",
  "CTO",
  "CMO",
  "CHRO",
];

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
};

export type LogEntry = {
  id: string;
  ts: number;
  action: "add" | "delete" | "rename" | "move" | "reset" | "save" | "role";
  detail: string;
};

export type AppState = {
  nodes: OrgNode[];
  selectedId: string | null;
  log: LogEntry[];
  toast: { kind: "info" | "error"; message: string } | null;
};
