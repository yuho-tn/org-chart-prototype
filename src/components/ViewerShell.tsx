import { ReactFlowProvider } from "reactflow";
import { ViewTabs } from "./ViewTabs";
import { PersonDetailModal } from "./PersonDetailModal";
import { Toast } from "./Toast";
import { ViewBody } from "./ViewBody";
import { useUiStore } from "../store/useUiStore";
import { clearShareParamsFromUrl } from "../lib/share";

/** Read-only share-link layout (?v=<id>). Lazily loaded like EditorShell. */
export default function ViewerShell({
  view,
}: {
  view: ReturnType<typeof useUiStore.getState>["view"];
}) {
  const sharedLabel = useUiStore((s) => s.sharedVersionLabel);

  function openInEditor() {
    clearShareParamsFromUrl();
    window.location.reload();
  }

  return (
    <ReactFlowProvider>
      <div className={`app app--viewer app--view-${view}`}>
        <header className="topbar topbar--viewer">
          <div className="topbar__brand">TalentHub</div>
          <span className="topbar__badge is-saved">閲覧モード</span>
          {sharedLabel && (
            <span className="topbar__viewer-version">{sharedLabel}</span>
          )}
          <div className="topbar__spacer" />
          <button className="btn" onClick={openInEditor} title="編集モードで開く">
            編集モードで開く
          </button>
        </header>
        <ViewTabs />
        <div className="app__main app__main--viewer">
          <div className="app__content">
            <ViewBody view={view} />
          </div>
        </div>
        <PersonDetailModal />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
