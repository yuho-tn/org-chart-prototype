/**
 * Tiny helpers that broadcast the current drag operation to the rest of the
 * UI through a body class, so any component can react via CSS without
 * subscribing to a state store.
 *
 *  - is-dragging          : any drag in progress
 *  - is-dragging-dept     : a department card is being dragged
 *  - is-dragging-person   : a person chip / executive pill is being dragged
 */
export type DragKind = "dept" | "person" | null;

export function setDragKind(kind: DragKind) {
  const body = document.body;
  body.classList.toggle("is-dragging", kind !== null);
  body.classList.toggle("is-dragging-dept", kind === "dept");
  body.classList.toggle("is-dragging-person", kind === "person");
}
