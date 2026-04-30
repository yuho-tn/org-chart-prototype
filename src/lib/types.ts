export type NodeKind = "department" | "person";

export type DeptCategory = "ROOT" | "DIV" | "TM" | "Unit" | "DEPT";

/**
 * Role label shown in a person chip's "leader" strip when present.
 * Null/undefined means a regular member.
 */
export type PersonRole = "CEO" | "DM" | "TM" | "UL" | "CTL" | "TL" | null;

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
