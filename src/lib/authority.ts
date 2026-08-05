import type { OrgNode, PersonRole } from "./types";
import { CHALLENGE_ROLES, EXECUTIVE_ROLES, ROLE_DESCRIPTIONS } from "./types";

/**
 * 権限組織図（#/org の「組織図」タブ）のデータ導出。
 *
 * 背景（2026-08-05 権限組織図MTG / 小澤・森岡・丹野）：
 * 既存の「体制図」は全メンバーを載せる社内発表用の図で、**誰が決裁権を持つか**が
 * 読み取れない。BillOne 等の承認ツールで一次／二次承認者を当て込む時、コーポレートも
 * 本人も「自分に権限があるのか」が分からず混乱している。
 *
 * そこでこのモジュールは、体制図と同じ1枚のデータ（OrgNode[]）から
 * **マネージャー以上だけ**を抜き出し、CEO / 役員 / DM / TM の4レイヤーに
 * 横軸を揃えて並べ直す。データを二重管理しない（体制図を直せば権限図も直る）。
 *
 * ── チャレンジ任用の扱い（本モジュールの肝） ─────────────────────────
 * CDM / CTM / CTL は「役割先行」の任用で、そのレイヤーの決裁権を持たない。
 * よってチャレンジ任用者しかいない組織では、**上の階層へ遡って実際に決裁できる人**を
 * その組織の権限者として表示する（丹野さん指示 2026-08-05）：
 *   - マーケティングDIV / 制作DIV は CDM しかいない → 実質DMは 丹野裕鵬（事業統括COO）
 *   - 広告TM / AIO TM は CTM しかいない → 実質マネージャーは 和田洋祐（マーケDIVのCDM）
 *
 * 一見ねじれて見えるが、これは「チャレンジ=1つ下のレイヤーの権限は持っている」と
 * 読むと一貫する。CDM 和田さんは DM の決裁権は無いが TM 相当の権限は持つので、
 * TMレイヤーの実質マネージャーにはなれる。これを `authorityLevel()` の
 * 「チャレンジは1段下げる」で表現し、必要レベルを満たす人が見つかるまで
 * 親をたどる（`resolveOwner`）。
 */

/** 4レイヤー。Unit / L 層は「マネージャー以上のみ」の方針で対象外。 */
export type AuthorityLayer = "ceo" | "exec" | "div" | "tm";

export const LAYER_LABEL: Record<AuthorityLayer, string> = {
  ceo: "CEO",
  exec: "役員",
  div: "DIVマネージャー",
  tm: "TMマネージャー",
};

export const LAYER_NOTE: Record<AuthorityLayer, string> = {
  ceo: "全社の最終決裁",
  exec: "DIVマネージャーを管掌",
  div: "TMマネージャーを管掌・Division PL",
  tm: "チームメンバーを管掌・チームPL",
};

/**
 * 決裁の重み。数字が大きいほど上位。
 * チャレンジ任用（CDM/CTM/CTL）は「1つ下のレイヤー相当」として扱う。
 */
export function authorityLevel(role: PersonRole): number {
  if (!role) return 0;
  if (EXECUTIVE_ROLES.includes(role)) return 4; // CEO/COO/CTO/CFO/CHRO/CRO/CMO
  switch (role) {
    case "DM":
      return 3;
    case "CDM": // チャレンジDM = TM相当
      return 2;
    case "TM":
      return 2;
    case "CTM": // チャレンジTM = リーダー相当
      return 1;
    case "TL":
    case "UL":
      return 1;
    case "CTL":
      return 0;
    default:
      return 0;
  }
}

export function isChallenge(role: PersonRole): boolean {
  return !!role && CHALLENGE_ROLES.includes(role);
}

/** レイヤーを担うのに必要な決裁レベル。 */
const REQUIRED: Record<Exclude<AuthorityLayer, "ceo">, number> = {
  exec: 4,
  div: 3,
  tm: 2,
};

/** そのレイヤーの「正式ロール」。ここに完全一致する人が最優先で権限者になる。 */
const FORMAL_ROLE: Record<Exclude<AuthorityLayer, "ceo" | "exec">, PersonRole> = {
  div: "DM",
  tm: "TM",
};

export type AuthorityPerson = {
  nodeId: string;
  name: string;
  role: NonNullable<PersonRole>;
  roleDescription: string;
  employeeNumber: string | null;
  isConcurrent: boolean;
  isChallenge: boolean;
};

export type AuthorityUnit = {
  /** 組織（部署）ノードのid。CEO段は擬似id CEO_UNIT_ID。 */
  id: string;
  name: string;
  layer: AuthorityLayer;
  /** 決裁権を持つ人（＝承認ルートに載せる人）。不在なら null。 */
  owner: AuthorityPerson | null;
  /**
   * owner が自組織ではなく上位から繰り上がった場合 true。
   * このとき「実質」バッジを出し、どこから繰り上がったかを ownerFrom に持つ。
   */
  ownerIsActing: boolean;
  /** 繰り上がり元の組織名（例：広告TM の owner はマーケティングDIVから）。 */
  ownerFrom: string | null;
  /** チャレンジ任用で実務を回している本人（併記用）。 */
  challengers: AuthorityPerson[];
  /** 同じ組織に在籍する役員（コーポレートTMのCFO等）。 */
  executives: AuthorityPerson[];
  /** 所属親組織の名前（線を追わなくても所属が読めるように）。 */
  parentName: string | null;

  /* ── ツリー描画用（ピラミッド型レイアウト） ───────────────────
   * レイヤー行を必ず揃えたまま親子を線で結ぶため、最下層の葉の数を
   * 列数とする grid に各ノードを「自分のサブツリーが占める列範囲」で
   * 置く。これで親が子の真ん中に乗り、行スキップ（HR TM のように
   * 役員直下のTM＝DM行を飛ばす枝）があっても行は揃う。 */
  /** 親ユニットのid。CEO段は null。 */
  parentUnitId: string | null;
  /** 1始まりの列開始位置（レイヤーラベル列は含めない）。 */
  colStart: number;
  /** 占有列数＝サブツリーの葉の数。 */
  colSpan: number;
};

export type AuthorityLayerRow = {
  layer: AuthorityLayer;
  units: AuthorityUnit[];
};

export type AuthorityCompany = {
  id: string;
  name: string;
  ceo: AuthorityPerson[];
  /** レイヤー順（CEO→役員→DM→TM）。空のレイヤーは含めない。 */
  layers: AuthorityLayerRow[];
  /** grid の総列数＝ツリーの葉の数。 */
  totalCols: number;
  /** 部門付き役員（Exe統括を持たずDIV/TMに在籍する役員）。 */
  attachedExecutives: { person: AuthorityPerson; unitName: string }[];
  /**
   * 法人ROOT直下に部署を介さず置かれている CEO 以外の役職者
   * （（株）ハウジングナビの COO 飯田さん・DM 国兼さん等）。
   * 部署カードが1枚も無い関連会社はこれだけが権限情報になる。
   */
  rootOfficers: AuthorityPerson[];
};

export type AuthorityChart = {
  main: AuthorityCompany | null;
  /** ネストした別法人ROOT（（株）ハウジングナビ等）。 */
  affiliates: AuthorityCompany[];
};

export const CEO_UNIT_ID = "__ceo__";

function cleanName(s: string): string {
  return s.replace(/^\*+\s*/, "").trim();
}

function toPerson(n: OrgNode): AuthorityPerson {
  const role = n.roleLabel as NonNullable<PersonRole>;
  return {
    nodeId: n.id,
    name: cleanName(n.name),
    role,
    roleDescription: ROLE_DESCRIPTIONS[role] ?? "",
    employeeNumber: n.employeeNumber ?? null,
    isConcurrent: !!n.isConcurrent,
    isChallenge: isChallenge(role),
  };
}

/** dept 直下の、ロールを持つ人ノード（未配置は除く）。 */
function leadersOf(childrenOf: Map<string, OrgNode[]>, deptId: string): AuthorityPerson[] {
  return (childrenOf.get(deptId) ?? [])
    .filter((n) => n.kind === "person" && !n.isUnplaced && n.roleLabel)
    .map(toPerson);
}

/**
 * 組織 `deptId` の権限者を決める。
 *  ① 自組織にレイヤーの正式ロール保持者がいればその人（例：フロントDIVのDM 高谷）
 *  ② 自組織に必要レベルを満たす人がいればその人（例：コーポレートTMのCFO 小澤）
 *  ③ いなければ親組織へ繰り上げて①②を繰り返す（例：広告TM → マーケDIVの和田）
 * ③で決まった場合は ownerIsActing=true（＝「実質」表示）。
 */
function resolveOwner(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  deptId: string,
  layer: Exclude<AuthorityLayer, "ceo">,
): { owner: AuthorityPerson | null; acting: boolean; from: string | null } {
  const required = REQUIRED[layer];
  const formal = layer === "div" || layer === "tm" ? FORMAL_ROLE[layer] : null;

  let cur: OrgNode | undefined = nodes.get(deptId);
  let hops = 0;
  while (cur) {
    const leaders = leadersOf(childrenOf, cur.id);
    const exact = formal ? leaders.find((p) => p.role === formal) : undefined;
    const best = leaders
      .filter((p) => authorityLevel(p.role) >= required)
      .sort((a, b) => authorityLevel(b.role) - authorityLevel(a.role))[0];
    const picked = exact ?? best;
    if (picked) {
      return {
        owner: picked,
        acting: hops > 0,
        from: hops > 0 ? cur.name : null,
      };
    }
    hops += 1;
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    // 会社の境目（ネストROOT）は越えない
    if (cur && cur.category === "ROOT" && hops > 0) {
      const rootLeaders = leadersOf(childrenOf, cur.id).filter(
        (p) => authorityLevel(p.role) >= required,
      );
      if (rootLeaders.length) {
        const top = rootLeaders.sort(
          (a, b) => authorityLevel(b.role) - authorityLevel(a.role),
        )[0];
        return { owner: top, acting: true, from: cur.name };
      }
      return { owner: null, acting: false, from: null };
    }
  }
  return { owner: null, acting: false, from: null };
}

function buildUnit(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  dept: OrgNode,
  layer: Exclude<AuthorityLayer, "ceo">,
): AuthorityUnit {
  const leaders = leadersOf(childrenOf, dept.id);
  const { owner, acting, from } = resolveOwner(nodes, childrenOf, dept.id, layer);
  const parent = dept.parentId ? nodes.get(dept.parentId) : undefined;
  return {
    id: dept.id,
    name: dept.name,
    layer,
    owner,
    ownerIsActing: acting,
    ownerFrom: from,
    // チャレンジ本人（＝実務担当）。owner と同一人物なら重複表示しない。
    // CTL（チャレンジTMリーダー）はリーダー層なので「マネージャー以上のみ」の方針で除外。
    challengers: leaders.filter(
      (p) => p.isChallenge && p.role !== "CTL" && p.nodeId !== owner?.nodeId,
    ),
    executives: leaders.filter(
      (p) => EXECUTIVE_ROLES.includes(p.role) && p.nodeId !== owner?.nodeId,
    ),
    parentName: parent && parent.category !== "ROOT" ? parent.name : null,
    // ツリー配置は buildCompany が確定させる
    parentUnitId: null,
    colStart: 1,
    colSpan: 1,
  };
}

/**
 * ある組織の「親ユニット」＝ツリー上の直近の祖先で、権限図に載る組織
 * （Exe / DIV / TM）。見つからず法人ROOTに達したら CEO 段にぶら下げる。
 * これで HR TM（事業統括の直下＝DM層を飛ばす枝）も正しく親へつながる。
 */
function parentUnitOf(nodes: Map<string, OrgNode>, dept: OrgNode): string {
  let cur: OrgNode | undefined = dept.parentId ? nodes.get(dept.parentId) : undefined;
  while (cur) {
    if (cur.category === "Exe" || cur.category === "DIV" || cur.category === "TM") {
      return cur.id;
    }
    if (cur.category === "ROOT") return CEO_UNIT_ID;
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return CEO_UNIT_ID;
}

/** ある組織が属する法人ROOT。ネストROOT（子会社）があればそちらを返す。 */
function rootOf(nodes: Map<string, OrgNode>, node: OrgNode): string | null {
  let cur: OrgNode | undefined = node;
  while (cur) {
    if (cur.category === "ROOT") return cur.id;
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
  }
  return null;
}

const LAYER_ORDER: AuthorityLayer[] = ["ceo", "exec", "div", "tm"];

function buildCompany(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  root: OrgNode,
  depts: OrgNode[],
): AuthorityCompany {
  const rootLeaders = leadersOf(childrenOf, root.id);
  const ceo = rootLeaders.filter((p) => p.role === "CEO");

  const ceoUnit: AuthorityUnit = {
    id: CEO_UNIT_ID,
    name: root.name,
    layer: "ceo",
    owner: ceo[0] ?? null,
    ownerIsActing: false,
    ownerFrom: null,
    challengers: [],
    executives: ceo.slice(1),
    parentName: null,
    parentUnitId: null,
    colStart: 1,
    colSpan: 1,
  };

  const units: AuthorityUnit[] = [ceoUnit];
  for (const d of depts) {
    const layer =
      d.category === "Exe" ? "exec" : d.category === "DIV" ? "div" : d.category === "TM" ? "tm" : null;
    if (!layer) continue; // Unit / DEPT はマネージャー以上の図には載せない
    const unit = buildUnit(nodes, childrenOf, d, layer);
    unit.parentUnitId = parentUnitOf(nodes, d);
    units.push(unit);
  }

  const byId = new Map(units.map((u) => [u.id, u]));
  const childrenOfUnit = new Map<string, AuthorityUnit[]>();
  for (const u of units) {
    if (!u.parentUnitId) continue;
    // 親が存在しない（データ不整合）場合は CEO 段へ退避させ、迷子カードを作らない
    const pid = byId.has(u.parentUnitId) ? u.parentUnitId : CEO_UNIT_ID;
    u.parentUnitId = pid;
    const arr = childrenOfUnit.get(pid) ?? [];
    arr.push(u);
    childrenOfUnit.set(pid, arr);
  }
  // 子の並びはレイヤー順（DIV → 直下TM）。同レイヤー内は元の並び順を保つ。
  for (const arr of childrenOfUnit.values()) {
    arr.sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer));
  }

  // 葉の数を列数として、各ノードにサブツリーの列範囲を割り当てる（DFS）。
  let cursor = 1;
  function assign(u: AuthorityUnit): number {
    const kids = childrenOfUnit.get(u.id) ?? [];
    if (kids.length === 0) {
      u.colStart = cursor;
      u.colSpan = 1;
      cursor += 1;
      return 1;
    }
    const from = cursor;
    let span = 0;
    for (const k of kids) span += assign(k);
    u.colStart = from;
    u.colSpan = span;
    return span;
  }
  assign(ceoUnit);
  const totalCols = Math.max(1, cursor - 1);

  const layers: AuthorityLayerRow[] = LAYER_ORDER.map((layer) => ({
    layer,
    units: units
      .filter((u) => u.layer === layer)
      .sort((a, b) => a.colStart - b.colStart),
  })).filter((r) => r.units.length > 0);

  // 部門付き役員：Exe統括を持たずDIV/TMに在籍している役員を補足表示する
  // （AI DIV・コーポレートTMの承認ルートが読めない、というMTGでの指摘への対応）。
  const attachedExecutives: AuthorityCompany["attachedExecutives"] = [];
  for (const unit of units) {
    if (unit.layer === "ceo" || unit.layer === "exec") continue;
    const execs = [
      ...(unit.owner && EXECUTIVE_ROLES.includes(unit.owner.role) && !unit.ownerIsActing
        ? [unit.owner]
        : []),
      ...unit.executives,
    ];
    for (const p of execs) {
      if (attachedExecutives.some((x) => x.person.nodeId === p.nodeId)) continue;
      attachedExecutives.push({ person: p, unitName: unit.name });
    }
  }

  return {
    id: root.id,
    name: root.name,
    ceo,
    layers,
    totalCols,
    attachedExecutives,
    rootOfficers: rootLeaders
      .filter((p) => p.role !== "CEO" && authorityLevel(p.role) >= REQUIRED.div)
      .sort((a, b) => authorityLevel(b.role) - authorityLevel(a.role)),
  };
}

export function buildAuthorityChart(nodesArr: OrgNode[]): AuthorityChart {
  const nodes = new Map(nodesArr.map((n) => [n.id, n]));
  const childrenOf = new Map<string, OrgNode[]>();
  for (const n of nodesArr) {
    if (!n.parentId) continue;
    const arr = childrenOf.get(n.parentId) ?? [];
    arr.push(n);
    childrenOf.set(n.parentId, arr);
  }

  const roots = nodesArr.filter((n) => n.kind === "department" && n.category === "ROOT");
  // 親を持たない ROOT が本体、ネストした ROOT は関連会社。
  const mainRoot = roots.find((r) => !r.parentId) ?? roots[0] ?? null;
  if (!mainRoot) return { main: null, affiliates: [] };

  const deptsByRoot = new Map<string, OrgNode[]>();
  for (const n of nodesArr) {
    if (n.kind !== "department" || n.category === "ROOT") continue;
    const r = rootOf(nodes, n);
    if (!r) continue;
    const arr = deptsByRoot.get(r) ?? [];
    arr.push(n);
    deptsByRoot.set(r, arr);
  }

  const main = buildCompany(nodes, childrenOf, mainRoot, deptsByRoot.get(mainRoot.id) ?? []);
  const affiliates = roots
    .filter((r) => r.id !== mainRoot.id)
    .map((r) => buildCompany(nodes, childrenOf, r, deptsByRoot.get(r.id) ?? []));

  return { main, affiliates };
}

/** 表示件数のサマリ（ヘッダーの「マネージャー以上 N名」用）。 */
export function countManagers(chart: AuthorityChart): number {
  const ids = new Set<string>();
  const companies = [chart.main, ...chart.affiliates].filter(Boolean) as AuthorityCompany[];
  for (const c of companies) {
    c.rootOfficers.forEach((p) => ids.add(p.employeeNumber ?? p.name));
    for (const row of c.layers) {
      for (const unit of row.units) {
        if (unit.owner) ids.add(unit.owner.employeeNumber ?? unit.owner.name);
        unit.challengers.forEach((p) => ids.add(p.employeeNumber ?? p.name));
        unit.executives.forEach((p) => ids.add(p.employeeNumber ?? p.name));
      }
    }
  }
  return ids.size;
}
