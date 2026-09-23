import type { DeptCategory, OrgNode, PersonRole } from "./types";
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
 * ── チャレンジ任用の扱い ────────────────────────────────────────
 * CDM / CTM / CTL は「役割先行」の任用で、そのレイヤーの決裁権を持たない。
 * よってチャレンジ任用者しかいない組織では、**上の階層へ遡って実際に決裁できる人**を
 * その組織の権限者として表示する（丹野さん指示 2026-08-05）：
 *   - マーケティングDIV / 制作DIV は CDM しかいない → 実質DMは 丹野裕鵬（事業統括COO）
 *   - AIO TM は CTM しかいない → 実質マネージャーは 和田洋祐（マーケティングDIVのCDM）
 *
 * 一見ねじれて見えるが、これは「チャレンジ=1つ下のレイヤーの権限は持っている」と
 * 読むと一貫する。CDM 和田さんは DM の決裁権は無いが TM 相当の権限は持つので、
 * TMレイヤーの実質マネージャーにはなれる。これを `authorityLevel()` の
 * 「チャレンジは1段下げる」で表現し、必要レベルを満たす人が見つかるまで
 * 親をたどる（`resolveOwner`）。
 *
 * ── 2026-08-28 改訂：レイヤーは category ではなく「在籍する役職」から決める ──
 * 旧実装は組織カードの行（役員／DM／TM）を dept.category だけで決めていた。
 * 体制図側で category が実態とずれると（営業統括・財務・労務統括が Exe ではなく
 * DIV、広告TM が TM ではなく DIV で登録されていた）、体制図を正しく直しても
 * 権限図が追従しない＝「赤穂さん・小澤さんが役員ラインに出ない」という
 * 裕鵬さんの指摘（2026-08-28）になる。
 *
 * そこでレイヤーは **その組織に実際に在籍している役職** から導出する
 * （役員がいる組織＝役員段／DM・CDMがいる＝DM段／TM・CTMがいる＝TM段。
 * 役職者が誰もいない組織だけ category にフォールバック）。人事発令で人を
 * 動かせば、category を触らなくても権限図の段が自動で切り替わる。
 *
 * ── 2026-08-28 改訂：抜けたレイヤーを「兼務セル」で必ず埋める ────────
 * 「全ての組織に役員・DIVマネージャー・TMマネージャーがいる状態にする」
 * （裕鵬さん 2026-08-28）。役員直下のTM（HR TM）や、TMを持たないDIV
 * （フロントDIV）は段が歯抜けになり、承認ルートが読めなかった。
 * 抜けた段には `isBridge` のセルを差し込み、その段の決裁を担う上位者を置く：
 *   - AI DIV の上に役員がいない        → 高谷一起（CEO）
 *   - コーポレートTM の上にDMがいない  → 高谷一起（財務・労務統括のDM）
 *   - HR TM の上にDMがいない           → 丹野裕鵬（事業統括のCOO）
 *   - フロントDIV の下にTMがいない     → 赤穂洋和（フロントDIVのDM）
 * これも手入力ではなく体制図からの導出なので、発令で人が変われば追従する。
 */

/** 4レイヤー。Unit / L 層は「マネージャー以上のみ」の方針で対象外。 */
export type AuthorityLayer = "ceo" | "exec" | "div" | "tm";
/** CEO段を除いた、組織カードが載る3段。 */
export type ManagerLayer = Exclude<AuthorityLayer, "ceo">;

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

const LAYER_ORDER: AuthorityLayer[] = ["ceo", "exec", "div", "tm"];

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
const REQUIRED: Record<ManagerLayer, number> = {
  exec: 4,
  div: 3,
  tm: 2,
};

/** そのレイヤーの「正式ロール」。ここに完全一致する人が最優先で権限者になる。 */
const FORMAL_ROLE: Record<"div" | "tm", NonNullable<PersonRole>> = {
  div: "DM",
  tm: "TM",
};

/**
 * その役職が「どの段の役職か」。チャレンジ任用は決裁権こそ1段下だが、
 * 組織上はその段の役職なので同じ段に置く（CDM のいるDIVはDM段）。
 */
function roleLayer(role: PersonRole): ManagerLayer | null {
  if (!role) return null;
  if (EXECUTIVE_ROLES.includes(role)) return "exec";
  if (role === "DM" || role === "CDM") return "div";
  if (role === "TM" || role === "CTM") return "tm";
  return null; // TL / CTL / UL はマネージャー以上の図に段を作らない
}

/** 役職者が1人もいない組織のフォールバック。 */
const CATEGORY_LAYER: Partial<Record<DeptCategory, ManagerLayer>> = {
  Exe: "exec",
  DIV: "div",
  TM: "tm",
};

/** 権限図に載せる組織か（Unit / DEPT は「マネージャー以上のみ」の方針で対象外）。 */
function isUnitDept(node: OrgNode): boolean {
  return (
    node.kind === "department" &&
    (node.category === "Exe" || node.category === "DIV" || node.category === "TM")
  );
}

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
  /** 組織（部署）ノードのid。CEO段は擬似id CEO_UNIT_ID、兼務セルは擬似id。 */
  id: string;
  /** 権限者の探索に使う実組織のid（兼務セルは、その段が抜けている組織のid）。 */
  deptId: string;
  name: string;
  layer: AuthorityLayer;
  /** 決裁権を持つ人（＝承認ルートに載せる人）。不在なら null。 */
  owner: AuthorityPerson | null;
  /**
   * owner が自組織ではなく上位から繰り上がった場合 true。
   * このとき「実質」の補足を tooltip に出し、繰り上がり元を ownerFrom に持つ。
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
  /**
   * その段の役職者が体制図に居らず、上位（または自組織の上位役職）が
   * 兼ねていることを示す補完セル。実在の組織カードと区別して描く。
   */
  isBridge: boolean;

  /* ── ツリー描画用（ピラミッド型レイアウト） ───────────────────
   * レイヤー行を必ず揃えたまま親子を線で結ぶため、最下層の葉の数を
   * 列数とする grid に各ノードを「自分のサブツリーが占める列範囲」で
   * 置く。これで親が子の真ん中に乗り、段が揃う。 */
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
  /** 部門付き役員（役員段のカードを持たずDIV/TMに在籍する役員）。 */
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
 * その組織が載る段。**在籍している役職**で決める（category は最後の保険）。
 * 体制図で人を動かせば段が自動で切り替わるようにするための中核。
 *
 * ── 「同居しているだけの役員」で段を上げない（2026-08-28 裕鵬さんFB） ──
 * 配下に組織を持たない**末端チーム**に役員が在籍しているだけのケース
 * （5期8月・9月のコーポレートTM＝森岡CTM＋小澤CFO）で、素朴に「最上位の役職＝
 * 役員」と読むとチームごと役員段へ上がってしまい、決裁者まで小澤さんになる。
 * これは 2026-08-06 の確定ルール「同じ組織に在籍しているだけの役員は決裁者に
 * しない（コーポレートTMの決裁は代表の高谷さん）」と食い違う。
 *
 * そこで：
 *   - 配下に組織を持つ「統括／親組織」は、最上位の役職で段を決める
 *     （財務・労務統括＝CFO小澤＋DM高谷 → 役員段。裕鵬さん指示 #2）
 *   - 配下に組織を持たない「末端チーム」は、役員を除いた管理職で段を決める
 *     （コーポレートTM＝CTM森岡＋CFO小澤 → TM段。小澤さんは役員チップで併記）
 */
function layerOfDept(
  dept: OrgNode,
  leaders: AuthorityPerson[],
  hasChildUnits: boolean,
): ManagerLayer | null {
  const found = new Set(leaders.map((p) => roleLayer(p.role)).filter(Boolean));
  const nonExec = found.has("div") || found.has("tm");
  if (found.has("exec") && (hasChildUnits || !nonExec)) return "exec";
  if (found.has("div")) return "div";
  if (found.has("tm")) return "tm";
  if (found.has("exec")) return "exec";
  return (dept.category && CATEGORY_LAYER[dept.category]) ?? null;
}

/**
 * その段を担える人を、候補の中から選ぶ。
 * 「必要レベルを満たす中で **一番近い（低い）** 人」を採る。最上位を採ると
 * コーポレートTMの決裁が DM の高谷さんを飛ばして CFO の小澤さんになってしまい、
 * 承認は1段ずつ上がるという実務（2026-08-06 裕鵬さん指示）と食い違う。
 */
function pickForLayer(
  leaders: AuthorityPerson[],
  required: number,
  formal: NonNullable<PersonRole> | null,
  allowNonFormal: boolean,
): AuthorityPerson | undefined {
  if (formal) {
    const exact = leaders.find((p) => p.role === formal);
    if (exact) return exact;
    if (!allowNonFormal) return undefined;
  }
  return leaders
    .filter((p) => authorityLevel(p.role) >= required)
    .sort((a, b) => authorityLevel(a.role) - authorityLevel(b.role))[0];
}

/**
 * 組織 `deptId` の権限者を決める。
 *  ① 自組織にレイヤーの正式ロール保持者がいればその人（例：フロントDIVのDM 高谷）
 *  ② 自組織に必要レベルを満たす人がいればその人
 *  ③ いなければ親組織へ繰り上げて①②を繰り返す（例：AIO TM → マーケDIVの和田）
 * ③で決まった場合は acting=true（＝「実質」表示）。
 *
 * `allowNonFormalAtSelf` は、その段の役職者が居ないことが分かっている
 * 「兼務セル」用。実在の組織カードでは false のままにして、同じ組織に
 * 在籍しているだけの上位役職者を決裁者にしない（2026-08-06 の確定ルール）。
 */
function resolveOwner(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  deptId: string,
  layer: ManagerLayer,
  allowNonFormalAtSelf = false,
): { owner: AuthorityPerson | null; acting: boolean; from: string | null } {
  const required = REQUIRED[layer];
  const formal = layer === "div" || layer === "tm" ? FORMAL_ROLE[layer] : null;

  let cur: OrgNode | undefined = nodes.get(deptId);
  let hops = 0;
  while (cur) {
    const picked = pickForLayer(
      leadersOf(childrenOf, cur.id),
      required,
      formal,
      hops > 0 || allowNonFormalAtSelf,
    );
    if (picked) {
      return { owner: picked, acting: hops > 0, from: hops > 0 ? cur.name : null };
    }
    hops += 1;
    cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
    // 会社の境目（ネストROOT）は越えない
    if (cur && cur.category === "ROOT" && hops > 0) {
      const top = pickForLayer(leadersOf(childrenOf, cur.id), required, null, true);
      return top
        ? { owner: top, acting: true, from: cur.name }
        : { owner: null, acting: false, from: null };
    }
  }
  return { owner: null, acting: false, from: null };
}

function buildUnit(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  dept: OrgNode,
  layer: ManagerLayer,
): AuthorityUnit {
  const leaders = leadersOf(childrenOf, dept.id);
  const { owner, acting, from } = resolveOwner(nodes, childrenOf, dept.id, layer);
  const parent = dept.parentId ? nodes.get(dept.parentId) : undefined;
  return {
    id: dept.id,
    deptId: dept.id,
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
    isBridge: false,
    // ツリー配置は buildCompany が確定させる
    parentUnitId: null,
    colStart: 1,
    colSpan: 1,
  };
}

/**
 * 抜けている段を埋める「兼務セル」。`forDeptId` の組織にはその段の役職者が
 * 居ないので、上位（または自組織の上位役職）から決裁できる人を引き当てる。
 *
 * `anchor` はその組織自身の決裁者。**その人が既に必要レベルを満たしているなら、
 * 上の段もその人が兼ねる**。こうしないと、末端に同居している別の役職者が
 * 拾われて「CEOの上にCFOが乗る」ような逆転が起きる（5期8月のコーポレートTM）。
 */
function buildBridge(
  nodes: Map<string, OrgNode>,
  childrenOf: Map<string, OrgNode[]>,
  forDeptId: string,
  forName: string,
  layer: ManagerLayer,
  parentUnitId: string,
  anchor: AuthorityPerson | null,
): AuthorityUnit {
  const resolved =
    anchor && authorityLevel(anchor.role) >= REQUIRED[layer]
      ? { owner: anchor, acting: false, from: null }
      : resolveOwner(nodes, childrenOf, forDeptId, layer, true);
  const { owner, acting, from } = resolved;
  return {
    id: `__bridge__${layer}__${forDeptId}`,
    deptId: forDeptId,
    name: forName,
    layer,
    owner,
    ownerIsActing: acting,
    ownerFrom: from,
    challengers: [],
    executives: [],
    parentName: null,
    isBridge: true,
    parentUnitId,
    colStart: 1,
    colSpan: 1,
  };
}

/**
 * ある組織の「親ユニット」＝ツリー上の直近の祖先で、権限図に載る組織。
 * 見つからず法人ROOTに達したら CEO 段にぶら下げる。
 */
function parentUnitOf(
  nodes: Map<string, OrgNode>,
  dept: OrgNode,
  unitDeptIds: Set<string>,
): string {
  let cur: OrgNode | undefined = dept.parentId ? nodes.get(dept.parentId) : undefined;
  while (cur) {
    if (unitDeptIds.has(cur.id)) return cur.id;
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
    deptId: root.id,
    name: root.name,
    layer: "ceo",
    owner: ceo[0] ?? null,
    ownerIsActing: false,
    ownerFrom: null,
    challengers: [],
    executives: ceo.slice(1),
    parentName: null,
    isBridge: false,
    parentUnitId: null,
    colStart: 1,
    colSpan: 1,
  };

  // ① 段は「在籍する役職」から決める（category ではなく）
  const unitCandidates = depts.filter(isUnitDept);
  const candidateIds = new Set(unitCandidates.map((d) => d.id));
  /** その組織の配下（Unitを挟んでいてもよい）に、権限図に載る組織があるか。 */
  const hasChildUnits = (dept: OrgNode) =>
    unitCandidates.some((other) => {
      let cur: OrgNode | undefined = other.parentId ? nodes.get(other.parentId) : undefined;
      while (cur) {
        if (cur.id === dept.id) return true;
        if (candidateIds.has(cur.id) || cur.category === "ROOT") return false;
        cur = cur.parentId ? nodes.get(cur.parentId) : undefined;
      }
      return false;
    });

  const layerOf = new Map<string, ManagerLayer>();
  for (const d of unitCandidates) {
    const layer = layerOfDept(d, leadersOf(childrenOf, d.id), hasChildUnits(d));
    if (layer) layerOf.set(d.id, layer);
  }
  const unitDeptIds = new Set(layerOf.keys());

  const units: AuthorityUnit[] = [ceoUnit];
  for (const d of depts) {
    const layer = layerOf.get(d.id);
    if (!layer) continue;
    const unit = buildUnit(nodes, childrenOf, d, layer);
    unit.parentUnitId = parentUnitOf(nodes, d, unitDeptIds);
    units.push(unit);
  }

  const byId = new Map(units.map((u) => [u.id, u]));
  // 親が存在しない（データ不整合）場合は CEO 段へ退避させ、迷子カードを作らない
  for (const u of units) {
    if (!u.parentUnitId) continue;
    if (!byId.has(u.parentUnitId)) u.parentUnitId = CEO_UNIT_ID;
  }

  const layerIdx = (l: AuthorityLayer) => LAYER_ORDER.indexOf(l);

  // ② 親子の間で飛んでいる段を埋める
  //    （AI DIV の上に役員がいない／HR TM・コーポレートTM の上にDMがいない）
  for (const u of [...units]) {
    if (u.layer === "ceo") continue;
    const parent = byId.get(u.parentUnitId!);
    if (!parent) continue;
    const gap = LAYER_ORDER.slice(
      layerIdx(parent.layer) + 1,
      layerIdx(u.layer),
    ) as ManagerLayer[];
    let above = parent.id;
    for (const layer of gap) {
      const bridge = buildBridge(nodes, childrenOf, u.deptId, u.name, layer, above, u.owner);
      units.push(bridge);
      byId.set(bridge.id, bridge);
      above = bridge.id;
    }
    u.parentUnitId = above;
  }

  // ③ 一番下（TM段）まで届いていない枝を埋める
  //    （フロントDIV のように配下がUnitだけでTMが立っていない組織）
  const hasChild = new Set(units.map((u) => u.parentUnitId).filter(Boolean) as string[]);
  for (const u of [...units]) {
    if (u.layer === "ceo" || hasChild.has(u.id)) continue;
    const below = LAYER_ORDER.slice(layerIdx(u.layer) + 1) as ManagerLayer[];
    let above = u.id;
    for (const layer of below) {
      const bridge = buildBridge(nodes, childrenOf, u.deptId, u.name, layer, above, u.owner);
      units.push(bridge);
      byId.set(bridge.id, bridge);
      above = bridge.id;
    }
  }

  // ④ 親子マップを組み直して列を割り当てる
  const childrenOfUnit = new Map<string, AuthorityUnit[]>();
  for (const u of units) {
    if (!u.parentUnitId) continue;
    const arr = childrenOfUnit.get(u.parentUnitId) ?? [];
    arr.push(u);
    childrenOfUnit.set(u.parentUnitId, arr);
  }
  // 子の並びはレイヤー順（DIV → 直下TM）。同レイヤー内は元の並び順を保つ。
  for (const arr of childrenOfUnit.values()) {
    arr.sort((a, b) => layerIdx(a.layer) - layerIdx(b.layer));
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

  // 部門付き役員：役員段のカードを持たずDIV/TMに在籍している役員を補足表示する。
  const attachedExecutives: AuthorityCompany["attachedExecutives"] = [];
  for (const unit of units) {
    if (unit.layer === "ceo" || unit.layer === "exec" || unit.isBridge) continue;
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

/** 兼務セルの説明文（カードの tooltip）。 */
export function bridgeNote(unit: AuthorityUnit): string {
  const layer = LAYER_LABEL[unit.layer];
  if (!unit.owner) {
    return `${unit.name} に ${layer} が置かれておらず、代わりに決裁できる役職者も見つかりません`;
  }
  const who = `${unit.owner.name}（${unit.owner.role}）`;
  return unit.ownerIsActing
    ? `${unit.name} に ${layer} が置かれていないため、${unit.ownerFrom ?? "上位"} の ${who} が ${layer} 相当の決裁を担います`
    : `${unit.name} に ${layer} が置かれていないため、${who} が ${layer} 相当の決裁を兼ねます`;
}
