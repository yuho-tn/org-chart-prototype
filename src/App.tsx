import { useEffect, useState } from "react";
import { ReactFlowProvider } from "reactflow";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { LogPanel } from "./components/LogPanel";
import { Toast } from "./components/Toast";
import { AuthorPrompt } from "./components/AuthorPrompt";
import { UserManagementModal } from "./components/UserManagementModal";
import { EmployeesPage } from "./components/EmployeesPage";
import { AnnouncementsListPage } from "./components/AnnouncementsListPage";
import { AnnouncementDetailPage } from "./components/AnnouncementDetailPage";
import { ConfirmedBanner } from "./components/ConfirmedBanner";
import { ListView } from "./components/ListView";
import { ViewTabs } from "./components/ViewTabs";
import { useOrgStore } from "./store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "./store/useVersionsStore";
import { useUiStore } from "./store/useUiStore";
import { useAuthStore } from "./store/useAuthStore";
import { parseShareParams, clearShareParamsFromUrl } from "./lib/share";

export default function App() {
  const loadFromStorage = useOrgStore((s) => s.loadFromStorage);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const refreshVersions = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const setView = useUiStore((s) => s.setView);
  const setViewOnly = useUiStore((s) => s.setViewOnly);
  const setSharedVersionLabel = useUiStore((s) => s.setSharedVersionLabel);
  const view = useUiStore((s) => s.view);
  const viewOnly = useUiStore((s) => s.viewOnly);
  const route = useUiStore((s) => s.route);

  const [bootReady, setBootReady] = useState(false);
  const [shareInit, setShareInit] = useState<{ versionId: string | null; ready: boolean }>({
    versionId: null,
    ready: false,
  });

  // Parse share URL params once on mount.
  useEffect(() => {
    const params = parseShareParams();
    if (params.versionId) {
      setViewOnly(true);
      setView(params.view);
      setShareInit({ versionId: params.versionId, ready: true });
    } else {
      setShareInit({ versionId: null, ready: true });
    }
  }, [setView, setViewOnly]);

  // Globally enforce read-only when the signed-in user has 'viewer' role.
  // Per-version edit/view permissions are still applied by VersionsPanel,
  // but a viewer should never be able to flip back into edit mode regardless
  // of which version they happen to be looking at.
  const currentRole = useAuthStore((s) => s.currentUser?.role);
  useEffect(() => {
    if (currentRole === "viewer") setViewOnly(true);
  }, [currentRole, setViewOnly]);

  useEffect(() => {
    if (!shareInit.ready) return;
    if (!viewOnly && !bootReady) return; // editor mode waits for AuthorPrompt
    let cancelled = false;
    (async () => {
      if (viewOnly && shareInit.versionId) {
        // Shared link: load that specific version directly. No localStorage.
        if (!isSupabaseConfigured) return;
        await refreshVersions();
        if (cancelled) return;
        const versions = useVersionsStore.getState().versions;
        const meta = versions.find((v) => v.id === shareInit.versionId);
        const nodes = await getSnapshot(shareInit.versionId);
        if (cancelled) return;
        if (!nodes) {
          useOrgStore.getState().setToast({
            kind: "error",
            message:
              "共有リンクのバージョンが見つかりません。リンクが古いか削除された可能性があります。",
          });
          return;
        }
        setSharedVersionLabel(meta?.name ?? null);
        replaceNodes(nodes, {
          versionId: shareInit.versionId,
          versionLabel: meta?.name ?? "共有バージョン",
        });
        return;
      }

      // Editor boot: hydrate optimistic cache then load latest server version.
      loadFromStorage();
      if (!isSupabaseConfigured) return;
      await refreshVersions();
      if (cancelled) return;
      const latest = useVersionsStore.getState().versions[0];
      if (!latest) return;
      const draftRaw = (() => {
        try {
          return localStorage.getItem("org-chart-prototype:v2");
        } catch {
          return null;
        }
      })();
      if (draftRaw) {
        useOrgStore.setState({
          currentVersionId: latest.id,
          currentVersionLabel: latest.name,
          dirty: true,
        });
        return;
      }
      const nodes = await getSnapshot(latest.id);
      if (!cancelled && nodes) {
        replaceNodes(nodes, { versionId: latest.id, versionLabel: latest.name });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    shareInit,
    viewOnly,
    bootReady,
    loadFromStorage,
    refreshVersions,
    getSnapshot,
    replaceNodes,
    setSharedVersionLabel,
  ]);

  // Persist a draft to localStorage whenever nodes change (editor mode only).
  const nodes = useOrgStore((s) => s.nodes);
  useEffect(() => {
    if (viewOnly) return;
    if (!bootReady) return;
    try {
      localStorage.setItem("org-chart-prototype:v2", JSON.stringify({ nodes }));
    } catch {
      // ignore quota errors
    }
  }, [nodes, bootReady, viewOnly]);

  if (viewOnly) return <ViewerLayout view={view} />;

  // The Employees page is a sibling top-level view of the editor — both live
  // inside the editor app shell so the AuthorPrompt / global modals etc. are
  // shared, but the main pane swaps based on route.
  if (route.name === "employees") {
    return (
      <ReactFlowProvider>
        <AuthorPrompt onReady={() => setBootReady(true)} />
        <div className="app app--page">
          <EmployeesPage />
          <Toast />
          <UserManagementModal />
        </div>
      </ReactFlowProvider>
    );
  }

  if (route.name === "announcements") {
    return (
      <ReactFlowProvider>
        <AuthorPrompt onReady={() => setBootReady(true)} />
        <div className="app app--page">
          <AnnouncementsListPage />
          <Toast />
          <UserManagementModal />
        </div>
      </ReactFlowProvider>
    );
  }

  if (route.name === "announcement") {
    return (
      <ReactFlowProvider>
        <AuthorPrompt onReady={() => setBootReady(true)} />
        <div className="app app--page">
          <AnnouncementDetailPage id={route.id} />
          <Toast />
          <UserManagementModal />
        </div>
      </ReactFlowProvider>
    );
  }

  return (
    <ReactFlowProvider>
      <AuthorPrompt onReady={() => setBootReady(true)} />
      <div className={`app app--editor app--view-${view}`}>
        <TopBar />
        <ConfirmedBanner />
        <ViewTabs />
        <div className="app__main">
          <Sidebar />
          <div className="app__content">
            {view === "tree" ? (
              <div className="app__canvas">
                <Canvas />
              </div>
            ) : (
              <ListView />
            )}
          </div>
          <Inspector />
        </div>
        <Toast />
        <LogPanel />
        <UserManagementModal />
      </div>
    </ReactFlowProvider>
  );
}

function ViewerLayout({ view }: { view: "tree" | "list" }) {
  const sharedLabel = useUiStore((s) => s.sharedVersionLabel);

  function openInEditor() {
    clearShareParamsFromUrl();
    window.location.reload();
  }

  return (
    <ReactFlowProvider>
      <div className={`app app--viewer app--view-${view}`}>
        <header className="topbar topbar--viewer">
          <div className="topbar__brand">OrgChart Studio</div>
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
            {view === "tree" ? (
              <div className="app__canvas">
                <Canvas />
              </div>
            ) : (
              <ListView />
            )}
          </div>
        </div>
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
