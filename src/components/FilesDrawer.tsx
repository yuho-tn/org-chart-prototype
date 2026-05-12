import { useEffect } from "react";
import { useUiStore } from "../store/useUiStore";
import { VersionsPanel } from "./VersionsPanel";

/**
 * Centered modal hosting the 組織図ファイル list. Triggered from the
 * leftmost button in OrgSubNav. Files are the top-level concept (you
 * pick a file before deciding to 編集 / 人事発令 inside it), so a centered
 * modal — not a side drawer — matches that hierarchy and gives the
 * list, action buttons, and metadata enough room to breathe.
 *
 * The store key is still `filesDrawerOpen` for compatibility with the
 * previous drawer implementation — only the presentation changed.
 */
export function FilesDrawer() {
  const open = useUiStore((s) => s.filesDrawerOpen);
  const setOpen = useUiStore((s) => s.setFilesDrawerOpen);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div
      className="modal-backdrop files-modal-backdrop"
      onClick={() => setOpen(false)}
      role="presentation"
    >
      <div
        className="modal modal--files"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="組織図ファイル"
        aria-modal="true"
      >
        <button
          className="files-modal__close"
          onClick={() => setOpen(false)}
          title="閉じる (Esc)"
          aria-label="閉じる"
        >
          ×
        </button>
        <VersionsPanel />
      </div>
    </div>
  );
}
