import { useEffect, useState } from "react";
import { ReactFlowProvider } from "reactflow";
import { GlobalHeader } from "./components/GlobalHeader";
import { OrgSubNav } from "./components/OrgSubNav";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { LogPanel } from "./components/LogPanel";
import { Toast } from "./components/Toast";
import { AuthorPrompt } from "./components/AuthorPrompt";
import { EmployeesPage } from "./components/EmployeesPage";
import { UsersPage } from "./components/UsersPage";
import { AnnouncementsListPage } from "./components/AnnouncementsListPage";
import { AnnouncementDetailPage } from "./components/AnnouncementDetailPage";
import { ConfirmedBanner } from "./components/ConfirmedBanner";
import { ListView } from "./components/ListView";
import { ViewTabs } from "./components/ViewTabs";
import { useOrgStore } from "./store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "./store/useVersionsStore";
import { useUiStore, sectionOfRoute } from "./store/useUiStore";
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

  const currentRole = useAuthStore((s) => s.currentUser?.role);
  useEffect(() => {
    if (currentRole === "viewer") setViewOnly(true);
  }, [currentRole, setViewOnly]);

  useEffect(() => {
    if (!shareInit.ready) return;
    if (!viewOnly && !bootReady) return;
    let cancelled = false;
    (async () => {
      if (viewOnly && shareInit.versionId) {
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

  // Render the editor shell or a dedicated section page based on the route.
  // GlobalHeader is constant across all sections; what's *under* it changes.
  return (
    <ReactFlowProvider>
      <AuthorPrompt onReady={() => setBootReady(true)} />
      <div className={`app app--${sectionOfRoute(route)} app--view-${view}`}>
        <GlobalHeader />
        <SectionContent route={route} />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}

function SectionContent({ route }: { route: ReturnType<typeof useUiStore.getState>["route"] }) {
  if (route.name === "employees") {
    return (
      <>
        <EmployeesPage />
      </>
    );
  }

  if (route.name === "users") {
    return <UsersPage />;
  }

  if (route.name === "announcements") {
    return (
      <div className="orgshell">
        <OrgSubNav />
        <AnnouncementsListPage />
      </div>
    );
  }

  if (route.name === "announcement") {
    return (
      <div className="orgshell">
        <OrgSubNav />
        <AnnouncementDetailPage id={route.id} />
      </div>
    );
  }

  // Default: org → editor
  return <EditorShell />;
}

function EditorShell() {
  const view = useUiStore((s) => s.view);
  return (
    <div className="orgshell">
      <OrgSubNav />
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
      <LogPanel />
    </div>
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
