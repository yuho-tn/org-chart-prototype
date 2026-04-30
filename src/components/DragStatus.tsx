import { useDndStore } from "../store/useDndStore";

/**
 * Small ribbon shown at the top center of the canvas during any drag, so the
 * user can quickly see what is being dragged and what the current drop target
 * is. Hidden when no drag is in progress.
 */
export function DragStatus() {
  const dragging = useDndStore((s) => s.dragging);
  const hoverLabel = useDndStore((s) => s.hoverTargetLabel);
  const hoverState = useDndStore((s) => s.hoverTargetState);

  if (!dragging) return null;

  const arrow = "→";
  const target =
    hoverLabel ??
    (dragging.kind === "dept" ? "（カードまたは空白にドロップで配置）" : "（部署カードにドロップで配置）");

  const stateClass =
    hoverState === "valid"
      ? "drag-status--valid"
      : hoverState === "invalid"
        ? "drag-status--invalid"
        : "drag-status--neutral";

  return (
    <div className={`drag-status ${stateClass}`}>
      <span className="drag-status__icon" aria-hidden>
        ⇣
      </span>
      <span className="drag-status__source">
        <strong>{dragging.label}</strong>
        <span className="drag-status__source-kind">
          {dragging.kind === "dept" ? "部署" : "人員"}
          {dragging.source === "tray" && "・未配置"}
        </span>
      </span>
      <span className="drag-status__arrow">{arrow}</span>
      <span className="drag-status__target">
        {target}
      </span>
      {hoverState === "invalid" && (
        <span className="drag-status__warn">⚠ ここには配置できません</span>
      )}
    </div>
  );
}
