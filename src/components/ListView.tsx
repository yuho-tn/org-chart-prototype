import { useMemo } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";
import type { OrgNode } from "../lib/types";

type Tree = {
  node: OrgNode;
  leaders: OrgNode[];
  members: OrgNode[];
  children: Tree[];
  totalMembers: number;
};

function buildTree(nodes: OrgNode[]): Tree[] {
  const allById = new Map(nodes.map((n) => [n.id, n]));
  const isInTray = (n: OrgNode): boolean => {
    let cur: OrgNode | undefined = n;
    while (cur) {
      if (cur.isUnplaced) return true;
      cur = cur.parentId ? allById.get(cur.parentId) : undefined;
    }
    return false;
  };

  const placed = nodes.filter((n) => !isInTray(n));
  const childrenOf = new Map<string | null, OrgNode[]>();
  for (const n of placed) {
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }

  function buildOne(n: OrgNode): Tree {
    const kids = childrenOf.get(n.id) ?? [];
    const persons = kids.filter((k) => k.kind === "person");
    const subDepts = kids.filter((k) => k.kind === "department");
    const children = subDepts.map(buildOne);
    const total =
      persons.length + children.reduce((acc, c) => acc + c.totalMembers, 0);
    return {
      node: n,
      leaders: persons.filter((p) => p.roleLabel),
      members: persons.filter((p) => !p.roleLabel),
      children,
      totalMembers: total,
    };
  }

  const roots = (childrenOf.get(null) ?? [])
    .filter((n) => n.kind === "department")
    .map(buildOne);
  return roots;
}

function categoryColor(cat: string | undefined): string {
  switch (cat) {
    case "ROOT":
      return "#0b1220";
    case "Exe":
      return "#a16207";
    case "DIV":
      return "#1e40af";
    case "TM":
      return "#15803d";
    case "Unit":
      return "#7e22ce";
    default:
      return "#475569";
  }
}

function DeptBlock({ tree, depth }: { tree: Tree; depth: number }) {
  const { node, leaders, members, children, totalMembers } = tree;
  const setSelected = useOrgStore((s) => s.setSelected);
  const selectedId = useOrgStore((s) => s.selectedId);
  const directCount = leaders.length + members.length;
  const indent = depth * 16;
  const accent = categoryColor(node.category);

  return (
    <div className="lv-block" style={{ marginLeft: indent }}>
      <div
        className={`lv-block__header ${selectedId === node.id ? "is-selected" : ""}`}
        onClick={() => setSelected(node.id)}
      >
        <span
          className="lv-block__category"
          style={{ background: accent, color: "#fff" }}
        >
          {node.category ?? "DEPT"}
        </span>
        <span className="lv-block__name">{node.name}</span>
        <span className="lv-block__counts">
          直属{directCount}名 / 配下計{totalMembers}名
        </span>
      </div>
      {(leaders.length > 0 || members.length > 0) && (
        <ul className="lv-people">
          {leaders.map((p) => (
            <li
              key={p.id}
              className={`lv-person lv-person--leader ${selectedId === p.id ? "is-selected" : ""}`}
              onClick={() => setSelected(p.id)}
            >
              <span className="lv-person__role" style={{ background: accent }}>
                {p.roleLabel}
              </span>
              <span className="lv-person__name">{p.name}</span>
              {p.isExecutive && <span className="lv-person__badge">役員</span>}
            </li>
          ))}
          {members.map((p) => (
            <li
              key={p.id}
              className={`lv-person ${selectedId === p.id ? "is-selected" : ""}`}
              onClick={() => setSelected(p.id)}
            >
              <span className="lv-person__bullet" aria-hidden>
                ・
              </span>
              <span className="lv-person__name">{p.name}</span>
            </li>
          ))}
        </ul>
      )}
      {children.length > 0 && (
        <div className="lv-block__children">
          {children.map((c) => (
            <DeptBlock key={c.node.id} tree={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function ListView() {
  const nodes = useOrgStore((s) => s.nodes);
  const viewOnly = useUiStore((s) => s.viewOnly);
  const versionLabel = useOrgStore((s) => s.currentVersionLabel);
  const sharedLabel = useUiStore((s) => s.sharedVersionLabel);
  const trees = useMemo(() => buildTree(nodes), [nodes]);
  const headline = viewOnly ? sharedLabel : versionLabel;

  return (
    <div className="list-view">
      <div className="list-view__paper">
        <header className="list-view__head">
          <div>
            <div className="list-view__brandline">OrgChart Studio</div>
            <h1 className="list-view__title">組織体制図</h1>
            {headline && <div className="list-view__subtitle">{headline}</div>}
          </div>
          <div className="list-view__date">
            {new Date().toLocaleDateString("ja-JP", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}{" "}
            時点
          </div>
        </header>

        <div className="list-view__legend">
          <span className="lv-legend">
            <span className="lv-legend__chip" style={{ background: categoryColor("ROOT") }}>ROOT</span>
            <span className="lv-legend__chip" style={{ background: categoryColor("Exe") }}>Exe（役員）</span>
            <span className="lv-legend__chip" style={{ background: categoryColor("DIV") }}>DIV</span>
            <span className="lv-legend__chip" style={{ background: categoryColor("TM") }}>TM</span>
            <span className="lv-legend__chip" style={{ background: categoryColor("Unit") }}>Unit</span>
          </span>
        </div>

        <div className="list-view__body">
          {trees.length === 0 ? (
            <p className="list-view__empty">表示する組織がありません。</p>
          ) : (
            trees.map((t) => <DeptBlock key={t.node.id} tree={t} depth={0} />)
          )}
        </div>
      </div>
    </div>
  );
}
