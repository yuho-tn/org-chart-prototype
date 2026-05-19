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
import { SignInPage } from "./components/SignInPage";
import { EmployeesPage } from "./components/EmployeesPage";
import { UsersPage } from "./components/UsersPage";
import { AnnouncementsListPage } from "./components/AnnouncementsListPage";
import { AnnouncementDetailPage } from "./components/AnnouncementDetailPage";
import { ListView } from "./components/ListView";
import { AssignmentsView } from "./components/AssignmentsView";
import { ViewTabs } from "./components/ViewTabs";
import { FilesDrawer } from "./components/FilesDrawer";
import { PersonDetailModal } from "./components/PersonDetailModal";
import { useOrgStore } from "./store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "./store/useVersionsStore";
import { useEmployeesStore } from "./store/useEmployeesStore";
import { useUiStore, sectionOfRoute } from "./store/useUiStore";
import { useAuthStore } from "./store/useAuthStore";
import { usePresenceStore } from "./store/usePresenceStore";
import { useVersionsRealtime } from "./store/useVersionsRealtime";
import { parseShareParams, clearShareParamsFromUrl } from "./lib/share";
import {
  STORAGE_KEYS,
  readStorage,
  writeStorage,
  readDraft,
  writeDraft,
  clearDraft,
} from "./lib/storageKeys";

export default function App() {
  const hydrateDraft = useOrgStore((s) => s.hydrateDraft);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const refreshVersions = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const setView = useUiStore((s) => s.setView);
  const setViewOnly = useUiStore((s) => s.setViewOnly);
  const setSharedVersionLabel = useUiStore((s) => s.setSharedVersionLabel);
  const view = useUiStore((s) => s.view);
  const viewOnly = useUiStore((s) => s.viewOnly);
  const route = useUiStore((s) => s.route);

  const [shareInit, setShareInit] = useState<{ versionId: string | null; ready: boolean }>({
    versionId: null,
    ready: false,
  });
  // Gates the draft-persisting effect: until the boot restore has read the
  // stored draft, that effect must not run — otherwise its clearDraft()
  // would wipe the draft before boot ever sees it.
  const [bootRestored, setBootRestored] = useState(false);

  // Bootstrap Supabase Auth (session restore + onAuthStateChange listener).
  const initializeAuth = useAuthStore((s) => s.initialize);
  const authInitialized = useAuthStore((s) => s.initialized);
  const session = useAuthStore((s) => s.session);
  useEffect(() => {
    initializeAuth();
  }, [initializeAuth]);

  // bootReady gates the rest of the app shell. After the OAuth migration
  // it tracks "we have a usable session", which is what the data-loading
  // effect below was waiting for via the old AuthorPrompt callback.
  const bootReady = !!session;

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
    void (async () => {
      if (viewOnly && shareInit.versionId) {
        if (!isSupabaseConfigured) return;
        await Promise.all([
          refreshVersions(),
          useEmployeesStore.getState().refresh(),
        ]);
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

      if (!isSupabaseConfigured) {
        // Offline / unconfigured: still recover any local draft so work
        // isn't lost, just unbound (no server to sync against).
        const offlineDraft = readDraft();
        if (offlineDraft && "v" in offlineDraft) {
          hydrateDraft(offlineDraft.nodes as Parameters<typeof hydrateDraft>[0], {
            versionId: null,
            versionLabel: offlineDraft.versionLabel,
          });
        } else if (offlineDraft && "legacyNodes" in offlineDraft) {
          hydrateDraft(
            offlineDraft.legacyNodes as Parameters<typeof hydrateDraft>[0],
            { versionId: null, versionLabel: null },
          );
        }
        return;
      }
      await refreshVersions();
      if (cancelled) return;
      const versions = useVersionsStore.getState().versions;
      const draft = readDraft();

      // ── 1. A local draft exists ─────────────────────────────────────
      // Restore the user's unsaved work bound to the CORRECT file so a
      // later 保存 overwrites that file (not whatever was newest). This is
      // what makes multi-editor sync work: once saved & clean, the draft
      // is cleared and the next reload loads fresh server state.
      if (draft && "v" in draft) {
        const bound = draft.versionId
          ? versions.find((v) => v.id === draft.versionId)
          : null;
        if (draft.versionId && !bound) {
          // The bound file was deleted on the server. Keep the work but
          // detach it so it can only be saved as a NEW file.
          hydrateDraft(draft.nodes as Parameters<typeof hydrateDraft>[0], {
            versionId: null,
            versionLabel: null,
          });
          useOrgStore.getState().setToast({
            kind: "error",
            message:
              "編集中だったファイルがサーバから削除されていました。未保存の内容は新規ファイルとして保持しています。",
          });
          return;
        }
        hydrateDraft(draft.nodes as Parameters<typeof hydrateDraft>[0], {
          versionId: bound ? bound.id : null,
          versionLabel: bound ? bound.name : draft.versionLabel,
        });
        if (bound?.updated_at && bound.updated_at > draft.savedAt) {
          useOrgStore.getState().setToast({
            kind: "info",
            message: `「${bound.name}」は別の編集者がサーバ側で更新しています。あなたの未保存の編集を保持中です（保存すると上書き、破棄するとサーバ最新が反映されます）。`,
          });
        }
        return;
      }

      // Legacy unbound draft ({ nodes } only): we can't know which file it
      // belonged to, so restore it as an unsaved NEW file rather than risk
      // clobbering an unrelated server file.
      if (draft && "legacyNodes" in draft) {
        hydrateDraft(draft.legacyNodes as Parameters<typeof hydrateDraft>[0], {
          versionId: null,
          versionLabel: null,
        });
        useOrgStore.getState().setToast({
          kind: "info",
          message:
            "以前のローカル編集を新規ファイルとして復元しました（保存先が特定できないため）。必要なら「別名で保存」してください。",
        });
        return;
      }

      // ── 2. No draft → open the last file the user had, else newest ──
      if (versions.length === 0) return;
      const lastId = readStorage(STORAGE_KEYS.lastVersionId);
      const target =
        (lastId && versions.find((v) => v.id === lastId)) || versions[0];
      const nodes = await getSnapshot(target.id);
      if (!cancelled && nodes) {
        replaceNodes(nodes, { versionId: target.id, versionLabel: target.name });
      }
    })().finally(() => {
      // Boot restore is done (or bailed): the draft has been read, so the
      // persisting effect may now safely take over.
      setBootRestored(true);
    });
    return () => {
      cancelled = true;
    };
  }, [
    shareInit,
    viewOnly,
    bootReady,
    hydrateDraft,
    refreshVersions,
    getSnapshot,
    replaceNodes,
    setSharedVersionLabel,
  ]);

  const nodes = useOrgStore((s) => s.nodes);
  const dirty = useOrgStore((s) => s.dirty);
  useEffect(() => {
    if (viewOnly) return;
    if (!bootReady) return;
    if (!bootRestored) return;
    const st = useOrgStore.getState();
    // Remember the open file so a no-draft reload reopens it (instead of
    // jumping to the most-recently-created file).
    if (st.currentVersionId) {
      writeStorage(STORAGE_KEYS.lastVersionId, st.currentVersionId);
    }
    // Only persist a draft while there are genuine unsaved edits. Once the
    // state is clean (saved, or freshly loaded from the server) we clear
    // the draft so it can never shadow the shared server file again — this
    // is what lets other editors' saves sync in on the next load.
    if (!dirty) {
      clearDraft();
      return;
    }
    writeDraft({
      v: 3,
      versionId: st.currentVersionId,
      versionLabel: st.currentVersionLabel,
      savedAt: new Date().toISOString(),
      nodes,
    });
  }, [nodes, dirty, bootReady, viewOnly, bootRestored]);

  // Realtime presence: announce the current user on the shared collab
  // channel and keep the version_id payload in sync as the user navigates
  // between files. Viewer mode (read-only share link) doesn't broadcast.
  const currentUserEmail = useAuthStore((s) => s.currentUser?.email ?? null);
  const currentDisplayName = useAuthStore((s) => s.currentUser?.display_name ?? null);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const presenceSubscribe = usePresenceStore((s) => s.subscribe);
  const presenceUnsubscribe = usePresenceStore((s) => s.unsubscribe);
  const presenceUpdateVersionId = usePresenceStore((s) => s.updateVersionId);

  useEffect(() => {
    if (viewOnly) return;
    if (!currentUserEmail) return;
    presenceSubscribe({
      email: currentUserEmail,
      display_name: currentDisplayName,
      versionId: currentVersionId,
    });
    return () => {
      presenceUnsubscribe();
    };
    // Re-subscribe when the user switches identity. version_id changes are
    // handled by the second effect below — re-subscribing on every save
    // would churn the channel needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserEmail, viewOnly]);

  useEffect(() => {
    if (viewOnly) return;
    if (!currentUserEmail) return;
    presenceUpdateVersionId(currentVersionId);
  }, [currentVersionId, currentUserEmail, viewOnly, presenceUpdateVersionId]);

  // Phase 2: subscribe to org_versions Postgres Changes so other users'
  // saves are reflected in this client without a manual reload.
  const realtimeSubscribe = useVersionsRealtime((s) => s.subscribe);
  const realtimeUnsubscribe = useVersionsRealtime((s) => s.unsubscribe);
  useEffect(() => {
    if (viewOnly) return;
    if (!bootReady) return;
    realtimeSubscribe();
    return () => {
      realtimeUnsubscribe();
    };
  }, [bootReady, viewOnly, realtimeSubscribe, realtimeUnsubscribe]);

  if (viewOnly) return <ViewerLayout view={view} />;

  // Auth gate. While Supabase is resolving the session, hold a short
  // splash; after that, route to SignInPage when there's no session.
  if (!authInitialized) return <BootSplash />;
  if (!session) return <SignInPage />;

  // Render the editor shell or a dedicated section page based on the route.
  // GlobalHeader is constant across all sections; what's *under* it changes.
  return (
    <ReactFlowProvider>
      <div className={`app app--${sectionOfRoute(route)} app--view-${view}`}>
        <GlobalHeader />
        <SectionContent route={route} />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}

function BootSplash() {
  return (
    <div className="signin">
      <div className="signin__card">
        <p className="signin__lead" style={{ textAlign: "center" }}>読み込み中…</p>
      </div>
    </div>
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

function ViewBody({ view }: { view: ReturnType<typeof useUiStore.getState>["view"] }) {
  if (view === "tree") {
    return (
      <div className="app__canvas">
        <Canvas />
      </div>
    );
  }
  if (view === "assignments") {
    return <AssignmentsView />;
  }
  return <ListView />;
}

function EditorShell() {
  const view = useUiStore((s) => s.view);
  return (
    <div className="orgshell">
      <OrgSubNav />
      <TopBar />
      <ViewTabs />
      <div className="app__main">
        <div className="app__leftPane">
          <Sidebar />
          <Inspector />
        </div>
        <div className="app__content">
          <ViewBody view={view} />
        </div>
      </div>
      <LogPanel />
      <FilesDrawer />
    </div>
  );
}

function ViewerLayout({ view }: { view: ReturnType<typeof useUiStore.getState>["view"] }) {
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
