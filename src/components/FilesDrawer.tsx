import { useEffect } from "react";
import { useUiStore } from "../store/useUiStore";
import { VersionsPanel } from "./VersionsPanel";

/**
 * Slide-in drawer that hosts the 組織図ファイル list. Triggered from the
 * OrgSubNav (2nd-tier header) so files — being a "higher" concept than the
 * editor tools in the left sidebar — get more room and don't get pushed off
 * the bottom by 未配置従業員 etc.
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

  return (
    <>
      <div
        className={`drawer-backdrop ${open ? "is-open" : ""}`}
        onClick={() => setOpen(false)}
        aria-hidden={!open}
      />
      <aside
        className={`files-drawer ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        role="dialog"
        aria-label="組織図ファイル"
      >
        <button
          className="files-drawer__close"
          onClick={() => setOpen(false)}
          title="閉じる (Esc)"
          aria-label="閉じる"
        >
          ×
        </button>
        <VersionsPanel />
      </aside>
    </>
  );
}
