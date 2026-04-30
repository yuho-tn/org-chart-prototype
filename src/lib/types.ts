export type NodeKind = "department" | "person";

export type OrgNode = {
  id: string;
  kind: NodeKind;
  name: string;
  parentId: string | null;
  /** UI position; ignored when re-laying out */
  x: number;
  y: number;
};

export type LogEntry = {
  id: string;
  ts: number;
  action: "add" | "delete" | "rename" | "move" | "reset" | "save";
  detail: string;
};

export type AppState = {
  nodes: OrgNode[];
  selectedId: string | null;
  log: LogEntry[];
  toast: { kind: "info" | "error"; message: string } | null;
};
