import { Canvas } from "./Canvas";
import { ListView } from "./ListView";
import { AssignmentsView } from "./AssignmentsView";
import { AuthorityChartView } from "./AuthorityChartView";
import { MlRulesView } from "./MlRulesView";
import type { useUiStore } from "../store/useUiStore";

export function ViewBody({
  view,
}: {
  view: ReturnType<typeof useUiStore.getState>["view"];
}) {
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
  if (view === "authority") {
    return <AuthorityChartView />;
  }
  if (view === "ml") {
    return <MlRulesView />;
  }
  return <ListView />;
}
