import type { OrgNode } from "./types";

/**
 * Demo org modeled after a typical Japanese company structure:
 *  ROOT → Exe (executives) → DIV / TM siblings → sub-Units
 */
export function seedData(): OrgNode[] {
  const out: OrgNode[] = [];
  const dept = (
    id: string,
    name: string,
    parentId: string | null,
    category: OrgNode["category"],
    colorIndex?: number,
  ): OrgNode => ({ id, kind: "department", name, parentId, category, colorIndex });
  const person = (
    id: string,
    name: string,
    parentId: string,
    roleLabel: OrgNode["roleLabel"] = null,
    isExecutive = false,
  ): OrgNode => ({ id, kind: "person", name, parentId, roleLabel, isExecutive });

  // ROOT
  out.push(dept("d-root", "OrgChart Inc.", null, "ROOT"));
  out.push(person("p-ceo", "山田 太郎", "d-root", "CEO"));

  // Exe layer (役員部署)
  out.push(dept("d-exe", "役員 / Exe", "d-root", "Exe"));
  out.push(person("p-coo", "鈴木 健", "d-exe", "COO", true));
  out.push(person("p-cfo", "佐藤 真奈美", "d-exe", "CFO", true));
  out.push(person("p-cto", "田中 翔", "d-exe", "CTO", true));
  out.push(person("p-cmo", "高橋 由紀", "d-exe", "CMO", true));
  out.push(person("p-chro", "井上 玲奈", "d-exe", "CHRO", true));

  // AI TM (under Exe)
  out.push(dept("d-ai", "AI TM", "d-exe", "TM", 5));
  out.push(person("p-ai-tm", "高谷 一起", "d-ai", "TM"));
  out.push(dept("d-ai-prod", "商品開発Unit", "d-ai", "Unit", 5));
  out.push(person("p-ai-prod-ul", "丹野 裕司朗", "d-ai-prod", "UL"));
  out.push(person("p-ai-prod-1", "深代 凛", "d-ai-prod"));
  out.push(person("p-ai-prod-2", "本田 美咲", "d-ai-prod"));
  out.push(person("p-ai-prod-3", "LEE HANYOON", "d-ai-prod"));

  // Corporate TM (under Exe)
  out.push(dept("d-corp", "コーポレートTM", "d-exe", "TM", 4));
  out.push(person("p-corp-tm", "森岡 夏奈", "d-corp", "TM"));
  out.push(dept("d-corp-mng", "経営Unit", "d-corp", "Unit", 4));
  out.push(person("p-corp-mng-1", "佐々木 翔太", "d-corp-mng"));
  out.push(person("p-corp-mng-2", "神田 望", "d-corp-mng"));
  out.push(dept("d-corp-pr", "広報Unit", "d-corp", "Unit", 4));
  out.push(person("p-corp-pr-ul", "大西 季莉子", "d-corp-pr", "UL"));
  out.push(person("p-corp-pr-1", "本間 七海", "d-corp-pr"));

  // 制作 DIV (under Exe)
  out.push(dept("d-prod", "制作DIV", "d-exe", "DIV", 1));
  out.push(person("p-prod-dm", "三好 健司", "d-prod", "DM"));
  out.push(dept("d-prod-web", "WEB CREATIVE TM", "d-prod", "TM", 1));
  out.push(person("p-prod-web-tm", "横橋 渚", "d-prod-web", "TM"));
  out.push(dept("d-prod-web-dir", "ディレクターUnit", "d-prod-web", "Unit", 1));
  out.push(person("p-prod-web-dir-1", "横橋 渚", "d-prod-web-dir", "UL"));
  out.push(person("p-prod-web-dir-2", "篠原 涼", "d-prod-web-dir"));
  out.push(dept("d-prod-web-eng", "エンジニアUnit", "d-prod-web", "Unit", 2));
  out.push(person("p-prod-web-eng-1", "中元 竜二", "d-prod-web-eng", "UL"));
  out.push(person("p-prod-web-eng-2", "JEON RYANGWON", "d-prod-web-eng"));

  // マーケティング DIV (under Exe)
  out.push(dept("d-mk", "マーケティングDIV", "d-exe", "DIV", 0));
  out.push(person("p-mk-dm", "丹野 裕司朗", "d-mk", "DM"));
  out.push(dept("d-mk-ad", "広告TM", "d-mk", "TM", 0));
  out.push(person("p-mk-ad-tm", "高橋 健", "d-mk-ad", "TM"));
  out.push(person("p-mk-ad-1", "三村 賢介", "d-mk-ad"));
  out.push(person("p-mk-ad-2", "井上 耕平", "d-mk-ad"));

  return out;
}
