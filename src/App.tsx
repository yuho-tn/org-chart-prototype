import { useEffect } from "react";
import { ReactFlowProvider } from "reactflow";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { Canvas } from "./components/Canvas";
import { Inspector } from "./components/Inspector";
import { LogPanel } from "./components/LogPanel";
import { Toast } from "./components/Toast";
import { useOrgStore } from "./store/useOrgStore";

export default function App() {
  const loadFromStorage = useOrgStore((s) => s.loadFromStorage);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  return (
    <ReactFlowProvider>
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
