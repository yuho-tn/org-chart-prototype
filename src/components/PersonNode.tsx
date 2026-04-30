import { Handle, Position } from "reactflow";
import type { NodeProps } from "reactflow";

type PersonData = {
  name: string;
  selected: boolean;
  dropState: "none" | "valid" | "invalid";
};

function initials(name: string): string {
  const cleaned = name.replace(/\s+/g, " ").trim();
  if (!cleaned) return "?";
  const first = cleaned.split(/\s|\//)[0] ?? "";
  return first.slice(0, 2);
}

export function PersonNode({ data }: NodeProps<PersonData>) {
  const cls = [
    "node",
    "node--person",
    data.selected ? "is-selected" : "",
    data.dropState === "valid" ? "is-drop-valid" : "",
    data.dropState === "invalid" ? "is-drop-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={cls}>
      <Handle type="target" position={Position.Top} />
      <div className="node__avatar">{initials(data.name)}</div>
      <div className="node__name" title={data.name}>
        {data.name}
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
