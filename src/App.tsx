import { lazy, Suspense, useEffect, useState } from "react";
import { GlobalHeader } from "./components/GlobalHeader";
import { SystemSwitcher } from "./components/SystemSwitcher";
import { SalaryTablePage } from "./components/payroll/SalaryTablePage";
import { GradesPage } from "./components/payroll/GradesPage";
import { AuditLogPage } from "./components/payroll/AuditLogPage";
import { OrgSubNav } from "./components/OrgSubNav";
import { Toast } from "./components/Toast";
import { SignInPage } from "./components/SignInPage";
import { EmployeesPage } from "./components/EmployeesPage";
import { UsersPage } from "./components/UsersPage";
import { AnnouncementsListPage } from "./components/AnnouncementsListPage";
import { AnnouncementDetailPage } from "./components/AnnouncementDetailPage";
import { HomePage } from "./components/HomePage";
import { useOrgStore } from "./store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "./store/useVersionsStore";
import { useEmployeesStore } from "./store/useEmployeesStore";
import { useUiStore, sectionOfRoute, systemOfRoute, defaultRouteForSystem } from "./store/useUiStore";
import { useAuthStore } from "./store/useAuthStore";
import { canAccessPayroll, canManagePermissions } from "./lib/supabase";
import { usePresenceStore } from "./store/usePresenceStore";
import { useVersionsRealtime } from "./store/useVersionsRealtime";
import { parseShareParams, clearShareParamsFromUrl } from "./lib/share";
import {
  readDraft,
  writeDraft,
  clearDraft,
} from "./lib/storageKeys";

// The org-chart editor & share-link viewer pull in reactflow (~the largest
// dependency in the bundle). Load them lazily so 従業員マスター / 人事発令 /
// 給与 pages don't pay for it — this is what makes those pages open fast.
const EditorShell = lazy(() => import("./components/EditorShell"));
const ViewerShell = lazy(() => import("./components/ViewerShell"));
// P1: 従業員詳細（プロフィール）と権限管理も lazy — 通常の一覧閲覧では
// ロードさせない。
const EmployeeDetailPage = lazy(() =>
  import("./components/EmployeeDetailPage").then((m) => ({ default: m.EmployeeDetailPage })),
);
const PermissionsPage = lazy(() =>
  import("./components/PermissionsPage").then((m) => ({ default: m.PermissionsPage })),
);
// P2: ミッションシート系も lazy — 通常閲覧では読み込ませない。
const MissionsPage = lazy(() =>
  import("./components/mission/MissionsPage").then((m) => ({ default: m.MissionsPage })),
);
const MissionTemplatesPage = lazy(() =>
  import("./components/mission/MissionTemplatesPage").then((m) => ({ default: m.MissionTemplatesPage })),
);
const MissionTemplateEditorPage = lazy(() =>
  import("./components/mission/MissionTemplateEditorPage").then((m) => ({ default: m.MissionTemplateEditorPage })),
);
const MissionSheetPage = lazy(() =>
  import("./components/mission/MissionSheetPage").then((m) => ({ default: m.MissionSheetPage })),
);

export default function App() {
  const hydrateDraft = useOrgStore((s) => s.hydrateDraft);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const clearToBlank = useOrgStore((s) => s.clearToBlank);
  const refreshVersions = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const setView = useUiStore((s) => s.setView);
  const setFilesDrawerOpen = useUiStore((s) => s.setFilesDrawerOpen);
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
    // Stash the parsed params but defer the viewOnly decision until auth
    // resolves (see effect below). Otherwise a signed-in owner returning
    // to a tab whose URL still has `?v=<id>` from a prior session would
    // get locked into viewer mode for their own file.
    if (params.versionId) {
      setView(params.view);
      setShareInit({ versionId: params.versionId, ready: true });
    } else {
      setShareInit({ versionId: null, ready: true });
    }
  }, [setView]);

  // Once auth has resolved, decide what `?v=<id>` actually means:
  //   - signed-in user → treat as a deep link, clear the URL, open the
  //     file in editor mode (no viewer trap)
  //   - anonymous visitor → keep the link as a read-only share
  // Runs exactly once after the initial share-params parse.
  useEffect(() => {
    if (!shareInit.ready) return;
    if (!authInitialized) return;
    if (!shareInit.versionId) return;
    if (session) {
      // Owner returning to their own URL — strip the share param so the
      // next reload behaves like a normal sign-in and the main boot
      // restore picks the file from the local "last opened" pointer
      // rather than treating it as a share.
      clearShareParamsFromUrl();
      setShareInit({ versionId: null, ready: true });
    } else {
      // No session: this is a genuine share-link visit. Lock viewer mode.
      setViewOnly(true);
    }
    // Intentionally limited deps: we only want to react to auth resolving
    // and the initial share-params parse.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareInit.ready, authInitialized, session]);

  const currentRole = useAuthStore((s) => s.currentUser?.role);
  useEffect(() => {
    if (currentRole === "viewer") setViewOnly(true);
  }, [currentRole, setViewOnly]);

  // Guard: if a non-payroll user somehow lands on a #/payroll/* URL (typed
  // it, bookmarked it, demoted after the fact), bounce them back to the
  // TalentHub default. We wait until auth has resolved so we don't bounce
  // a payroll-capable user during the brief window before currentUser is
  // populated.
  const navigate = useUiStore((s) => s.navigate);
  useEffect(() => {
    if (!authInitialized) return;
    if (systemOfRoute(route) !== "payroll") return;
    if (canAccessPayroll(currentRole)) return;
    navigate(defaultRouteForSystem("talenthub"), { pushHistory: false });
  }, [authInitialized, route, currentRole, navigate]);

  // Same guard for the 権限管理 page (#/permissions) — master /
  // privileged_admin only.
  useEffect(() => {
    if (!authInitialized) return;
    if (route.name !== "permissions") return;
    if (canManagePermissions(currentRole)) return;
    navigate(defaultRouteForSystem("talenthub"), { pushHistory: false });
  }, [authInitialized, route, currentRole, navigate]);

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
        // Reflect the restored file in the address bar so a reload deep-links
        // back to it. Unbound (new) drafts fall back to the blank #/org URL.
        navigate(
          bound ? { name: "editor", versionId: bound.id } : { name: "editor" },
          { pushHistory: false },
        );
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

      // ── 2. No draft → stay blank ────────────────────────────────────
      // The org page now lands on an empty canvas; the file to show is
      // named by the URL (#/org/<id>) and loaded by the URL-driven effect
      // below. A bare #/org keeps the blank state + auto-opens the picker.
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
  // Read once at the top so it runs before any early-return branches —
  // hooks must be called in the same order on every render.
  const systemSwitching = useUiStore((s) => s.systemSwitching);

  // ── URL-driven file loading (#/org/<id>) ──────────────────────────────
  // The org page treats the URL as the source of truth for which file is on
  // screen: deep-links, reloads and browser back/forward all land on the
  // right file, and a bare #/org shows the blank picker. Runs after the boot
  // draft-restore so unsaved work is never clobbered.
  useEffect(() => {
    if (viewOnly) return; // anonymous ?v= share is handled separately
    if (!session) return;
    if (!bootRestored) return;
    if (route.name !== "editor") return;
    const wanted = route.versionId ?? null;
    const st = useOrgStore.getState();
    if (wanted === st.currentVersionId) return; // already showing it
    // #/org (no id): unload to the blank canvas — but never discard unsaved
    // edits silently. A dirty new draft (currentVersionId null) is kept.
    if (wanted === null) {
      if (st.currentVersionId && !st.dirty) clearToBlank();
      return;
    }
    // #/org/<id>: load that file. Guard unsaved edits with a confirm so a
    // back/forward doesn't wipe in-progress work.
    if (st.dirty) {
      const ok = window.confirm(
        "未保存の変更があります。別のファイルを開くと現在の変更は失われます。続けますか？",
      );
      if (!ok) {
        // Revert the address bar to the file that stays loaded.
        navigate(
          st.currentVersionId
            ? { name: "editor", versionId: st.currentVersionId }
            : { name: "editor" },
          { pushHistory: false },
        );
        return;
      }
    }
    let cancelled = false;
    void (async () => {
      const versions = useVersionsStore.getState().versions;
      const meta = versions.find((v) => v.id === wanted);
      const loaded = await getSnapshot(wanted);
      if (cancelled) return;
      if (!loaded) {
        useOrgStore.getState().setToast({
          kind: "error",
          message:
            "指定されたファイルが見つかりません（削除されたか、閲覧権限がない可能性があります）。",
        });
        clearToBlank();
        navigate({ name: "editor" }, { pushHistory: false });
        return;
      }
      replaceNodes(loaded, { versionId: wanted, versionLabel: meta?.name });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    route,
    viewOnly,
    session,
    bootRestored,
    getSnapshot,
    replaceNodes,
    clearToBlank,
    navigate,
  ]);

  // Auto-open the file picker when landing on the blank org page so the user
  // can immediately choose a file (the canvas is intentionally empty until
  // then). Only fires when truly blank — not while a file is open.
  useEffect(() => {
    if (viewOnly || !session || !bootRestored) return;
    if (route.name !== "editor" || route.versionId) return;
    if (useOrgStore.getState().currentVersionId) return;
    if (useOrgStore.getState().nodes.length > 0) return;
    setFilesDrawerOpen(true);
  }, [route, viewOnly, session, bootRestored, setFilesDrawerOpen]);

  useEffect(() => {
    if (viewOnly) return;
    if (!bootReady) return;
    if (!bootRestored) return;
    const st = useOrgStore.getState();
    // (The open file is no longer remembered via localStorage — the URL
    // (#/org/<id>) is now the source of truth for what reopens on reload.)
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

  // (Removed) The browser address bar used to auto-mirror the currently-
  // open file as `?v=<id>`. That clashed with the `?v=` share-link
  // semantics: on the next visit the boot effect read its own previously-
  // written URL as a "shared viewer link" and locked the signed-in owner
  // into viewer mode. Sharing is done explicitly via the Share dialog,
  // and the file picker shows what's open — the URL doesn't need to.

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

  if (viewOnly) {
    return (
      <Suspense fallback={<BootSplash />}>
        <ViewerShell view={view} />
      </Suspense>
    );
  }

  // Auth gate. While Supabase is resolving the session, hold a short
  // splash; after that, route to SignInPage when there's no session.
  if (!authInitialized) return <BootSplash />;
  if (!session) return <SignInPage />;

  // Render the editor shell or a dedicated section page based on the route.
  // SystemSwitcher (Talenthub vs Payroll) sits at the very top; GlobalHeader
  // adapts its tabs to the active system; the content area swaps below.
  const system = systemOfRoute(route);
  return (
    <div
      className={[
        "app",
        `app--system-${system}`,
        `app--${sectionOfRoute(route)}`,
        `app--view-${view}`,
        systemSwitching ? "app--system-switching" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <SystemSwitcher />
      <GlobalHeader />
      <SectionContent route={route} />
      <Toast />
    </div>
  );
}

function PageLoading() {
  return (
    <main className="page">
      <p style={{ padding: 24, color: "var(--text-muted)" }}>読み込み中…</p>
    </main>
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
  if (route.name === "home") {
    return <HomePage />;
  }

  if (route.name === "employees") {
    return (
      <>
        <EmployeesPage />
      </>
    );
  }

  if (route.name === "employee") {
    return (
      <Suspense fallback={<PageLoading />}>
        <EmployeeDetailPage num={route.num} />
      </Suspense>
    );
  }

  if (route.name === "missions") {
    return (
      <Suspense fallback={<PageLoading />}>
        <MissionsPage />
      </Suspense>
    );
  }

  if (route.name === "mission_templates") {
    return (
      <Suspense fallback={<PageLoading />}>
        <MissionTemplatesPage />
      </Suspense>
    );
  }

  if (route.name === "mission_template") {
    return (
      <Suspense fallback={<PageLoading />}>
        <MissionTemplateEditorPage id={route.id} />
      </Suspense>
    );
  }

  if (route.name === "mission_sheet") {
    return (
      <Suspense fallback={<PageLoading />}>
        <MissionSheetPage id={route.id} />
      </Suspense>
    );
  }

  if (route.name === "users") {
    return <UsersPage />;
  }

  if (route.name === "permissions") {
    return (
      <Suspense fallback={<PageLoading />}>
        <PermissionsPage />
      </Suspense>
    );
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

  // Payroll system pages
  if (route.name === "salary") return <SalaryTablePage />;
  if (route.name === "grades") return <GradesPage />;
  if (route.name === "audit_log") return <AuditLogPage />;

  // Default: org → editor. When no file is selected (bare #/org, blank
  // canvas) show a picker prompt instead of the empty editor. A deep-link
  // (#/org/<id>) keeps route.versionId set while loading, so it renders the
  // editor (which shows its own loading state), not this blank prompt.
  if (route.name === "editor" && !route.versionId) {
    return <OrgEditorOrBlank />;
  }
  return (
    <Suspense
      fallback={
        <div className="orgshell">
          <OrgSubNav />
          <p style={{ padding: 24, color: "var(--text-muted)" }}>エディタを読み込み中…</p>
        </div>
      }
    >
      <EditorShell />
    </Suspense>
  );
}

/**
 * Editor for the org section, or a blank "pick a file" prompt when nothing
 * is loaded yet. Splitting this out keeps the hook (useOrgStore) legal —
 * SectionContent returns early for other routes.
 */
function OrgEditorOrBlank() {
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const nodeCount = useOrgStore((s) => s.nodes.length);
  const setFilesDrawerOpen = useUiStore((s) => s.setFilesDrawerOpen);

  // A restored unsaved draft has nodes but no versionId — still a real file
  // in progress, so show the editor. Blank = no file AND no nodes.
  const isBlank = !currentVersionId && nodeCount === 0;
  if (!isBlank) {
    return (
      <Suspense
        fallback={
          <div className="orgshell">
            <OrgSubNav />
            <p style={{ padding: 24, color: "var(--text-muted)" }}>エディタを読み込み中…</p>
          </div>
        }
      >
        <EditorShell />
      </Suspense>
    );
  }

  return (
    <div className="orgshell">
      <OrgSubNav />
      <div className="orgblank">
        <div className="orgblank__card">
          <div className="orgblank__icon" aria-hidden>🗂</div>
          <h2 className="orgblank__title">組織図ファイルを選択してください</h2>
          <p className="orgblank__lead">
            表示するファイルを選ぶと、そのファイル専用のURL（#/org/&lt;ID&gt;）に切り替わります。
            アドレスバーをコピーすれば、その組織図をそのまま他のメンバーへ共有できます。
          </p>
          <button className="btn btn--primary" onClick={() => setFilesDrawerOpen(true)}>
            📁 ファイルを選択
          </button>
        </div>
      </div>
    </div>
  );
}
