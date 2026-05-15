import type { DeptCategory, OrgNode, PersonRole } from "./types";
import type { EmployeeRow } from "./supabase";

/**
 * Coarse seniority rank for PersonRole. Used to detect "promotion" — a role
 * change that strictly increases the rank. Roles within the same band are
 * treated as equal (e.g. moving TM ↔ CTM is not a promotion).
 *
 * Bands (high → low):
 *   100  CEO
 *    95  COO / CTO / CFO / CHRO / CRO / CMO  (other C-suite — equal among themselves)
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
  CRO: 95,
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
  category: DeptCategory,
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
  /** Legacy flat strings — kept for backward compatibility with rows
   *  saved before structured fields were introduced. New rows still
   *  populate these (= the moving department's name) so existing
   *  consumers that read .from / .to don't break. */
  from: string;
  to: string;
  /** Structured path components (added 2026-05). Older rows may have
   *  these absent; the renderer falls back to the flat from/to in that
   *  case. */
  from_div?: string | null;
  from_tm?: string | null;
  from_unit?: string | null;
  to_div?: string | null;
  to_tm?: string | null;
  to_unit?: string | null;
  note?: string;
};

export type AnnouncementPromotion = {
  employee_number: string;
  full_name: string;
  from_role: string;
  to_role: string;
  /** Department where this person sits AT THE TIME OF PROMOTION (chart B).
   *  Helps the announcement reader see "where" the person was promoted —
   *  the legacy data model had only roles, so older rows lack these. */
  div?: string | null;
  tm?: string | null;
  unit?: string | null;
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
    unit: string | null;
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
      const unit = ancestorOfCategory(n, byId, "Unit")?.name ?? null;
      out.set(n.employeeNumber, {
        node: n,
        div,
        tm,
        unit,
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

    const fullName =
      empByNumber.get(num)?.full_name ?? eb.node.name ?? num;
    // Both flat (legacy) and structured fields are populated. The flat
    // fields use the moving department's name so older renderers keep
    // working; structured fields give the new full-path renderer all
    // three levels (DIV / TM / Unit) at once.
    const fromStruct = {
      from_div: ea.div,
      from_tm: ea.tm,
      from_unit: ea.unit,
    };
    const toStruct = {
      to_div: eb.div,
      to_tm: eb.tm,
      to_unit: eb.unit,
    };

    // DIV change wins over TM change because moving across DIVs implicitly
    // changes TM too — we don't want to double-count.
    if ((ea.div ?? "") !== (eb.div ?? "")) {
      div_moves.push({
        employee_number: num,
        full_name: fullName,
        from: ea.div ?? "（未所属）",
        to: eb.div ?? "（未所属）",
        ...fromStruct,
        ...toStruct,
      });
    } else if ((ea.tm ?? "") !== (eb.tm ?? "")) {
      tm_moves.push({
        employee_number: num,
        full_name: fullName,
        from: ea.tm ?? "（TM外）",
        to: eb.tm ?? "（TM外）",
        ...fromStruct,
        ...toStruct,
      });
    }

    if (rankOf(eb.role) > rankOf(ea.role)) {
      promotions.push({
        employee_number: num,
        full_name: fullName,
        from_role: ea.role ?? "メンバー",
        to_role: eb.role ?? "メンバー",
        div: eb.div,
        tm: eb.tm,
        unit: eb.unit,
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

/**
 * Render a "DIV / TM / Unit" path. Empty levels collapse out. If the
 * row has no structured info at all, returns null so the caller can fall
 * back to the legacy flat string.
 */
export function formatDeptPath(
  div: string | null | undefined,
  tm: string | null | undefined,
  unit: string | null | undefined,
): string | null {
  const parts = [div, tm, unit].filter((s): s is string => !!s && s.trim() !== "");
  if (parts.length === 0) return null;
  return parts.join(" / ");
}

/** Group destination — used by the detail page to bucket transfers under
 *  the receiving department. For DIV moves we use to_div; for TM moves the
 *  receiving TM is the meaningful grouper (within an unchanged DIV). */
export function moveDestinationGroup(
  m: AnnouncementMove,
  kind: "div" | "tm",
): string {
  if (kind === "div") {
    return m.to_div ?? m.to ?? "（未指定）";
  }
  return m.to_tm ?? m.to ?? "（未指定）";
}
