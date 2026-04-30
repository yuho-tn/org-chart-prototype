import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";

type DepartmentData = {
  name: string;
  memberCount: number;
  selected: boolean;
  dropState: "none" | "valid" | "invalid";
};

export function DepartmentNode({ data }: NodeProps<DepartmentData>) {
  const cls = [
    "node",
    "node--department",
    data.selected ? "is-selected" : "",
    data.dropState === "valid" ? "is-drop-valid" : "",
    data.dropState === "invalid" ? "is-drop-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} />
      <div className="node__kind">DEPT</div>
      <div className="node__name" title={data.name}>
        {data.name}
      </div>
      <div className="node__meta">{data.memberCount}名</div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
