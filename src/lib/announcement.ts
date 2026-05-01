import type { OrgNode, PersonRole } from "./types";
import type { EmployeeRow } from "./supabase";

/**
 * Coarse seniority rank for PersonRole. Used to detect "promotion" — a role
 * change that strictly increases the rank. Roles within the same band are
 * treated as equal (e.g. moving TM ↔ CTM is not a promotion).
 *
 * Bands (high → low):
 *   100  CEO
 *    95  COO / CTO / CFO / CHRO / CSO / CMO  (other C-suite — equal among themselves)
 *    60  DM / CDM
 *    40  TM / CTM
 *    20  TL / CTL
 *    10  UL
 *     0  member (no role)
 */
const RANK: Record<NonNullable<PersonRole> | "member", number> = {
  CEO: 100,
  COO: 95,
  CTO: 95,
  CFO: 95,
  CHRO: 95,
  CSO: 95,
  CMO: 95,
  DM: 60,
  CDM: 60,
  TM: 40,
  CTM: 40,
  TL: 20,
  CTL: 20,
  UL: 10,
  member: 0,
};

function rankOf(role: PersonRole | undefined): number {
  if (!role) return RANK.member;
  return RANK[role] ?? 0;
}

/** Walk up from `node` to the nearest ancestor whose category matches. */
function ancestorOfCategory(
  node: OrgNode,
  byId: Map<string, OrgNode>,
  category: "DIV" | "TM",
): OrgNode | null {
  let cur: OrgNode | undefined = node;
  while (cur) {
    if (cur.category === category) return cur;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

export type AnnouncementHire = {
  employee_number: string;
  full_name: string;
  department: string | null;
  position_title: string | null;
  hired_at: string | null;
  note?: string;
};

export type AnnouncementLeave = {
  employee_number: string;
  full_name: string;
  department: string | null;
  position_title: string | null;
  left_at: string | null;
  note?: string;
};

export type AnnouncementMove = {
  employee_number: string;
  full_name: string;
  from: string;
  to: string;
  note?: string;
};

export type AnnouncementPromotion = {
  employee_number: string;
  full_name: string;
  from_role: string;
  to_role: string;
  note?: string;
};

export type AnnouncementPayload = {
  hires: AnnouncementHire[];
  leaves: AnnouncementLeave[];
  div_moves: AnnouncementMove[];
  tm_moves: AnnouncementMove[];
  promotions: AnnouncementPromotion[];
  notes: string;
};

export function emptyPayload(): AnnouncementPayload {
  return {
    hires: [],
    leaves: [],
    div_moves: [],
    tm_moves: [],
    promotions: [],
    notes: "",
  };
}

/** Returns true if the YYYY-MM-DD `date` falls inside the YYYY-MM `period`. */
function isInPeriod(date: string | null | undefined, period: string): boolean {
  if (!date) return false;
  return date.startsWith(period); // "2026-07-15".startsWith("2026-07") → true
}

/**
 * Compute the four announcement sections by diffing two charts and a roster.
 *
 *   - hires:     employees whose hired_at is within the target period
 *   - leaves:    employees whose left_at  is within the target period
 *   - div_moves / tm_moves: people whose containing DIV / TM differs
 *                           between the two charts
 *   - promotions: people whose role rank increased
 *
 * Only people with an `employeeNumber` on their person node are considered
 * for the chart-based diff sections; legacy nodes without that linkage are
 * skipped silently.
 */
export function computeAnnouncement(
  nodesA: OrgNode[],
  nodesB: OrgNode[],
  employees: EmployeeRow[],
  period: string,
): AnnouncementPayload {
  const empByNumber = new Map(employees.map((e) => [e.employee_number, e]));

  // Hires / leaves come straight from the master table — chart-independent.
  const hires: AnnouncementHire[] = employees
    .filter((e) => isInPeriod(e.hired_at, period))
    .map((e) => ({
      employee_number: e.employee_number,
      full_name: e.full_name ?? "",
      department: e.department,
      position_title: e.position_title,
      hired_at: e.hired_at,
    }))
    .sort((a, b) => (a.hired_at ?? "").localeCompare(b.hired_at ?? ""));

  const leaves: AnnouncementLeave[] = employees
    .filter((e) => isInPeriod(e.left_at, period))
    .map((e) => ({
      employee_number: e.employee_number,
      full_name: e.full_name ?? "",
      department: e.department,
      position_title: e.position_title,
      left_at: e.left_at,
    }))
    .sort((a, b) => (a.left_at ?? "").localeCompare(b.left_at ?? ""));

  // Build a "person-by-employee_number" projection for each chart.
  type ChartEntry = {
    node: OrgNode;
    div: string | null;
    tm: string | null;
    role: PersonRole;
  };
  function indexChart(nodes: OrgNode[]): Map<string, ChartEntry> {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const out = new Map<string, ChartEntry>();
    for (const n of nodes) {
      if (n.kind !== "person" || !n.employeeNumber) continue;
      if (n.isUnplaced) continue;
      const div = ancestorOfCategory(n, byId, "DIV")?.name ?? null;
      const tm = ancestorOfCategory(n, byId, "TM")?.name ?? null;
      out.set(n.employeeNumber, {
        node: n,
        div,
        tm,
        role: n.roleLabel ?? null,
      });
    }
    return out;
  }
  const a = indexChart(nodesA);
  const b = indexChart(nodesB);

  const div_moves: AnnouncementMove[] = [];
  const tm_moves: AnnouncementMove[] = [];
  const promotions: AnnouncementPromotion[] = [];

  for (const [num, eb] of b) {
    const ea = a.get(num);
    if (!ea) continue; // newcomer in chart B (already covered by hires if hired this period)

    // DIV change wins over TM change because moving across DIVs implicitly
    // changes TM too — we don't want to double-count.
    if ((ea.div ?? "") !== (eb.div ?? "")) {
      div_moves.push({
        employee_number: num,
        full_name:
          empByNumber.get(num)?.full_name ?? eb.node.name ?? num,
        from: ea.div ?? "（未所属）",
        to: eb.div ?? "（未所属）",
      });
    } else if ((ea.tm ?? "") !== (eb.tm ?? "")) {
      tm_moves.push({
        employee_number: num,
        full_name:
          empByNumber.get(num)?.full_name ?? eb.node.name ?? num,
        from: ea.tm ?? "（TM外）",
        to: eb.tm ?? "（TM外）",
      });
    }

    if (rankOf(eb.role) > rankOf(ea.role)) {
      promotions.push({
        employee_number: num,
        full_name:
          empByNumber.get(num)?.full_name ?? eb.node.name ?? num,
        from_role: ea.role ?? "メンバー",
        to_role: eb.role ?? "メンバー",
      });
    }
  }

  // Stable sort by name so output order is deterministic.
  const byName = (x: { full_name: string }, y: { full_name: string }) =>
    x.full_name.localeCompare(y.full_name, "ja");
  div_moves.sort(byName);
  tm_moves.sort(byName);
  promotions.sort(byName);

  return { hires, leaves, div_moves, tm_moves, promotions, notes: "" };
}

/** Format "2026-07" → "2026年7月度". */
export function formatPeriodHeading(period: string): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(period);
  if (!m) return period;
  return `${m[1]}年${parseInt(m[2], 10)}月度`;
}
