import { useState } from "react";
import { useReactFlow } from "reactflow";
import { useOrgStore } from "../store/useOrgStore";
import { VersionsPanel } from "./VersionsPanel";
import { TrayPanel } from "./TrayPanel";
import { EXECUTIVE_ROLES, ROLE_DESCRIPTIONS } from "../lib/types";

export function Sidebar() {
  const addDepartment = useOrgStore((s) => s.addDepartment);
  const addPerson = useOrgStore((s) => s.addPerson);
  const addExecutive = useOrgStore((s) => s.addExecutive);
  const rf = useReactFlow();
  const [execMenuOpen, setExecMenuOpen] = useState(false);

  return (
    <aside className="sidebar">
      <section className="sidebar__section">
        <h2 className="sidebar__title">新規追加</h2>
        <div className="sidebar__hint">
          新規ノードは <strong>未配置エリア</strong> に追加されます。
          <div className="sidebar__hintSub">
            未配置エリアからドラッグして、配置先の部署カードまたはキャンバスに直接ドロップしてください。
          </div>
        </div>
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
        <div className="sidebar__execRow">
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => setExecMenuOpen((v) => !v)}
            title="役員（CEO/COO/CTO/CFO/CHRO/CMO）を未配置で追加"
          >
            ＋役員 ▾
          </button>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => rf.fitView({ padding: 0.2, duration: 200 })}
          >
            フィットビュー
          </button>
        </div>
        {execMenuOpen && (
          <div className="exec-menu">
            {EXECUTIVE_ROLES.map((role) => (
              <button
                key={role}
                className="btn btn--ghost btn--xs exec-menu__item"
                onClick={() => {
                  addExecutive(role);
                  setExecMenuOpen(false);
                }}
                title={`${role}（${ROLE_DESCRIPTIONS[role]}）を未配置で追加`}
              >
                ＋{role}
              </button>
            ))}
          </div>
        )}
      </section>

      <TrayPanel />
      <VersionsPanel />
    </aside>
  );
}
