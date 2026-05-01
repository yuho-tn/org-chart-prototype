import { useEffect, type ReactNode } from "react";

/**
 * Generic two-button confirm modal. Use this whenever you'd reach for
 * `window.confirm` or hand-roll a yes/no modal — it keeps the chrome
 * consistent and gives us one place to evolve the styling.
 *
 * For destructive operations that need a stronger gesture (i.e. ファイル削除)
 * use HoldToConfirm instead — it asks the user to press-and-hold rather
 * than click once.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "OK",
  cancelLabel = "キャンセル",
  variant = "primary",
  onConfirm,
  onCancel,
  children,
}: {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">{title}</h3>
        {message && <p className="modal__body">{message}</p>}
        {children}
        <div className="modal__actions">
          <button className="btn btn--ghost" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            className={`btn btn--${variant}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
