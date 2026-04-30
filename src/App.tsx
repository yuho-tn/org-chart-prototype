import { useEffect, useState } from "react";
import { ReactFlowProvider } from "reactflow";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { LogPanel } from "./components/LogPanel";
import { Toast } from "./components/Toast";
import { AuthorPrompt } from "./components/AuthorPrompt";
import { useOrgStore } from "./store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "./store/useVersionsStore";

export default function App() {
  const loadFromStorage = useOrgStore((s) => s.loadFromStorage);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const refreshVersions = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);

  const [bootReady, setBootReady] = useState(false);

  useEffect(() => {
    if (!bootReady) return;
    let cancelled = false;
    (async () => {
      // 1. Hydrate the optimistic local cache so the UI is immediate.
      loadFromStorage();
      // 2. If Supabase is configured, fetch the latest version metadata and
      //    auto-load the most recent server snapshot.
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
        // Local draft exists; keep it but record the latest version label
        // so the dirty/saved badge is informative.
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
  }, [bootReady, loadFromStorage, refreshVersions, getSnapshot, replaceNodes]);

  // Persist a draft to localStorage whenever nodes change.
  const nodes = useOrgStore((s) => s.nodes);
  useEffect(() => {
    if (!bootReady) return;
    try {
      localStorage.setItem(
        "org-chart-prototype:v2",
        JSON.stringify({ nodes }),
      );
    } catch {
      // ignore quota errors
    }
  }, [nodes, bootReady]);

  return (
    <ReactFlowProvider>
      <AuthorPrompt onReady={() => setBootReady(true)} />
      <div className="app">
        <TopBar />
        <div className="app__main">
          <Sidebar />
          <div className="app__canvas">
            <Canvas />
          </div>
          <Inspector />
        </div>
        <LogPanel />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
