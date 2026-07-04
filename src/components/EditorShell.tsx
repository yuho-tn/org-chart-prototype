import { ReactFlowProvider } from "reactflow";
import { OrgSubNav } from "./OrgSubNav";
import { TopBar } from "./TopBar";
import { ViewTabs } from "./ViewTabs";
import { Sidebar } from "./Sidebar";
import { Inspector } from "./Inspector";
import { LogPanel } from "./LogPanel";
import { FilesDrawer } from "./FilesDrawer";
import { ViewBody } from "./ViewBody";
import { useUiStore } from "../store/useUiStore";

/**
 * The full org-chart editor. Split out of App.tsx and loaded lazily so the
 * (heavy) reactflow dependency is only downloaded when the user actually
 * opens the editor — 従業員マスター / 人事発令 / ユーザー管理 render without it.
 */
export default function EditorShell() {
  const view = useUiStore((s) => s.view);
  return (
    <ReactFlowProvider>
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
    </ReactFlowProvider>
  );
}
