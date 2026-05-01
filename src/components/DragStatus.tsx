import { useEffect } from "react";
import { useDndStore } from "../store/useDndStore";

/**
 * Small ribbon shown at the top center of the canvas during any drag, so the
 * user can quickly see what is being dragged and what the current drop target
 * is. Also reflects whether Alt/Option is held (copy vs move).
 * Hidden when no drag is in progress.
 */
export function DragStatus() {
  const dragging = useDndStore((s) => s.dragging);
  const hoverLabel = useDndStore((s) => s.hoverTargetLabel);
  const hoverState = useDndStore((s) => s.hoverTargetState);
  const copyMode = useDndStore((s) => s.copyMode);
  const setCopyMode = useDndStore((s) => s.setCopyMode);

  // Track Alt / Option globally so the ribbon shows "コピー" mode even before
  // the cursor moves into a drop event.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      setCopyMode(e.altKey);
    }
    function onBlur() {
      setCopyMode(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [setCopyMode]);

  if (!dragging) return null;

  const arrow = "→";
  const target =
    hoverLabel ??
    (dragging.kind === "dept" ? "（カードまたは空白にドロップで配置）" : "（部署カードにドロップで配置）");

  const stateClass =
    hoverState === "valid"
      ? copyMode
        ? "drag-status--copy"
        : "drag-status--valid"
      : hoverState === "invalid"
        ? "drag-status--invalid"
        : copyMode
          ? "drag-status--copy"
          : "drag-status--neutral";

  return (
    <div className={`drag-status ${stateClass}`}>
      <span className="drag-status__icon" aria-hidden>
        {copyMode ? "＋" : "⇣"}
      </span>
      <span className="drag-status__mode">{copyMode ? "コピー" : "移動"}</span>
      <span className="drag-status__source">
        <strong>{dragging.label}</strong>
        <span className="drag-status__source-kind">
          {dragging.kind === "dept" ? "部署" : "人員"}
          {dragging.source === "tray" && "・未配置"}
        </span>
      </span>
      <span className="drag-status__arrow">{arrow}</span>
      <span className="drag-status__target">{target}</span>
      {hoverState === "invalid" && (
        <span className="drag-status__warn">⚠ ここには配置できません</span>
      )}
      {!copyMode && hoverState === "valid" && (
        <span className="drag-status__hint">
          ⌥/Altで<strong>コピー</strong>
        </span>
      )}
    </div>
  );
}
