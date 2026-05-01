import { useOrgStore } from "../store/useOrgStore";
import { VersionsPanel } from "./VersionsPanel";
import { TrayPanel } from "./TrayPanel";
import { UnplacedEmployeesPanel } from "./UnplacedEmployeesPanel";

export function Sidebar() {
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);

  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <h2 className="sidebar__title">新規追加</h2>
        <div className="sidebar__btnRow">
          <button
            className="btn btn--primary"
            onClick={() => addDepartment(null)}
            title="未配置エリアに新しい部署を追加"
          >
            ＋部署
          </button>
          <button
            className="btn"
            onClick={() => addPerson(null)}
            title="未配置エリアに新しい人員を追加"
          >
            ＋人員
          </button>
        </div>
      </section>

      <TrayPanel />
      <UnplacedEmployeesPanel />
      <VersionsPanel />
    </aside>
  );
}
