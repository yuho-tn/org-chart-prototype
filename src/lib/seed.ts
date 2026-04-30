import type { OrgNode } from "./types";

export function seedData(): OrgNode[] {
  return [
    { id: "d-root", kind: "department", name: "経営企画本部", parentId: null, x: 0, y: 0 },
    { id: "d-sales", kind: "department", name: "営業部", parentId: "d-root", x: 0, y: 0 },
    { id: "p-ceo", kind: "person", name: "山田 太郎 / CEO", parentId: "d-root", x: 0, y: 0 },
    { id: "p-mgr", kind: "person", name: "佐藤 花子 / 営業部長", parentId: "d-sales", x: 0, y: 0 },
    { id: "p-a", kind: "person", name: "鈴木 一郎", parentId: "p-mgr", x: 0, y: 0 },
    { id: "p-b", kind: "person", name: "田中 二郎", parentId: "p-mgr", x: 0, y: 0 },
    { id: "p-c", kind: "person", name: "高橋 三郎", parentId: "d-sales", x: 0, y: 0 },
  ];
}
