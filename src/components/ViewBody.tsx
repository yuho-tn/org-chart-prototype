import { Canvas } from "./Canvas";
import { ListView } from "./ListView";
import { AssignmentsView } from "./AssignmentsView";
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
  return <ListView />;
}
