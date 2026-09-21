// アラート通知ダイジェストの純関数群（PULSE_V3_DESIGN.md §10-2・§10-4・§10-6）。
//
// Edge Function（pulse-alert-digest / pulse-comment-classify）から呼ばれる、
// DB・ネットワークに依存しない組み立て・正規化ロジックだけをここに置く
// （テスト可能にするため＝ alertDigest_test.ts）。
//
//   composeDailyDigest / composeImmediate … pulse_alert_digest_batch() の返り値から
//     Slack DM 本文（mrkdwn）を組む。severity critical→warn→info の順に並べ、
//     同一 severity 内はルール（rule_code）でまとめる。各行は
//     「氏名（部署）｜ルール label｜理由1行｜コメント要約」の固定フォーマット。
//     1メッセージ 3,500 文字を超える場合は件数を丸めて「…ほか N 件」を足す。
//
//   reasonLine … pulse_alerts.reason（ルール別 jsonb・§10-2）を日本語1行に整形する。
//
//   normalizeClassification … pulse-comment-classify が Claude から受け取った JSON を
//     11分類の固定値に丸める（§10-4）。不正値はすべて「分類困難」側へフォールバックし、
//     例外を投げない（呼び出し元がそのまま pulse_apply_classification に渡せる形を保証する）。

// ── 型 ────────────────────────────────────────────────────────────────

export interface AlertDigestRecipient {
  email: string;
  name?: string | null;
}

/** pulse_alert_digest_batch() の alerts[] 要素（§10-6 の列挙どおり）。 */
export interface AlertDigestAlert {
  id: string;
  period?: string | null;
  employee_number: string;
  name?: string | null;
  department?: string | null;
  rule_code: string;
  rule_label?: string | null;
  severity?: string | null;
  categories?: string[] | null;
  reason?: unknown;
  comment_summary?: string | null;
  created_at?: string | null;
}

export interface AlertDigestByState {
  todo?: number;
  doing?: number;
  on_hold_org?: number;
  done?: number;
  not_needed?: number;
}

/** service_role 専用 RPC pulse_alert_digest_batch(p_alert_ids) の返り値形。 */
export interface AlertDigestBatch {
  recipients: AlertDigestRecipient[];
  digest_enabled?: boolean;
  immediate_enabled?: boolean;
  alerts: AlertDigestAlert[];
  open_total: number;
  by_state: AlertDigestByState;
}

// ── reasonLine ───────────────────────────────────────────────────────

const WEATHER_LABEL: Record<number, string> = { 1: "荒天", 2: "雨", 3: "くもり", 4: "晴れ", 5: "快晴" };

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() !== "" ? v : fallback;
}

/** 数値らしければ渡された数のまま、そうでなければ "?" を返す（表示用の緩い整形）。 */
function numOrUnknown(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v;
  return "?";
}

/** overall/平均点は小数1桁に揃える（"4" → "4.0"）。数値化できなければ numOrUnknown と同じ。 */
function fmtOverall(v: unknown): string {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n.toFixed(1) : numOrUnknown(v);
}

function weatherLabel(score: unknown): string {
  const n = typeof score === "number" ? score : Number(score);
  return WEATHER_LABEL[n] ?? numOrUnknown(score);
}

/** "YYYY-MM" の配列を "2026-09〜11"（同年）/ "2026-11〜2027-01"（年またぎ）に圧縮する。 */
function formatPeriodRange(periods: string[]): string {
  const valid = periods.filter((p) => /^\d{4}-\d{2}$/.test(p)).sort();
  if (valid.length === 0) return "";
  if (valid.length === 1) return valid[0];
  const first = valid[0];
  const last = valid[valid.length - 1];
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return `${first}〜${last.slice(5, 7)}`;
  }
  return `${first}〜${last}`;
}

/**
 * pulse_alerts.reason（ルール別 jsonb・§10-2）を日本語1行へ整形する。
 * 未知の rule_code は reason.rule（ルールラベル）があればそれを、無ければ固定文言を返す
 * （例外は投げない＝ダイジェスト全体を1件の異常データで落とさない）。
 */
export function reasonLine(ruleCode: string, reason: unknown): string {
  const r = asRecord(reason);

  switch (ruleCode) {
    case "geppo_stormy":
    case "geppo_rain2": {
      const items = asArray(r.items).map(asRecord);
      if (items.length === 0) return "該当項目あり";
      return items.map((it) => `${strOr(it.category, "?")}＝${weatherLabel(it.score)}`).join("・");
    }
    case "geppo_drop2": {
      const items = asArray(r.items).map(asRecord);
      if (items.length === 0) return "該当項目あり";
      return items
        .map((it) =>
          `${strOr(it.category, "?")} ${numOrUnknown(it.prev)}→${numOrUnknown(it.cur)}（前回 ${
            strOr(it.prev_period, "?")
          }）`
        )
        .join("・");
    }
    case "preset_all_cloudy":
      return "天気4項目すべてくもり";
    case "preset_decline_3m": {
      const series = asArray(r.series).map(asRecord);
      if (series.length === 0) return "総合が3か月連続下降";
      return "総合 " + series.map((s) => fmtOverall(s.overall)).join("→");
    }
    case "preset_same_3m": {
      const periods = asArray(r.periods).filter((p): p is string => typeof p === "string");
      const months = periods.length > 0 ? periods.length : 3;
      return `${months}か月同じ回答`;
    }
    case "preset_org_change": {
      const prev = strOr(r.prev_department, "不明");
      const cur = strOr(r.department, "不明");
      return `${prev} → ${cur}`;
    }
    case "preset_unanswered_3m": {
      const periods = asArray(r.periods).filter((p): p is string => typeof p === "string");
      const range = formatPeriodRange(periods);
      return range ? `${range} 未回答` : "3か月未回答";
    }
    case "legacy_absolute": {
      return `総合 ${fmtOverall(r.overall)}（閾値${numOrUnknown(r.threshold)}以下）`;
    }
    case "legacy_delta": {
      return `総合 ${fmtOverall(r.prev_overall)}→${fmtOverall(r.overall)}`;
    }
    default: {
      if (ruleCode.startsWith("comment_")) {
        const category = strOr(r.category, "分類困難");
        const summary = typeof r.summary === "string" ? r.summary.trim() : "";
        return summary ? `[${category}] ${summary}` : `[${category}]`;
      }
      const label = typeof r.rule === "string" && r.rule.trim() !== "" ? r.rule : null;
      return label ?? "詳細不明";
    }
  }
}

// ── normalizeClassification ─────────────────────────────────────────

/** pulse_comment_classifications.categories の固定11分類（§10-4）。 */
export const COMMENT_CATEGORIES = [
  "SOS",
  "体調不安",
  "人間関係",
  "仕事",
  "評価",
  "キャリア",
  "プライベート",
  "総務",
  "要望/提言",
  "組織課題",
  "分類困難",
] as const;

export type CommentCategory = (typeof COMMENT_CATEGORIES)[number];
export type ClassificationSeverity = "low" | "mid" | "high";

export interface NormalizedClassification {
  categories: string[];
  primary: string;
  severity: ClassificationSeverity;
  summary: string;
}

const COMMENT_CATEGORY_SET = new Set<string>(COMMENT_CATEGORIES);
const FALLBACK_CATEGORY: CommentCategory = "分類困難";
const MAX_CATEGORIES = 3;
const MAX_SUMMARY_CHARS = 60;

/**
 * Claude の分類結果（JSON.parse 済み・型不明）を11分類の固定値へ丸める。
 *   ・categories: 11分類のうち有効な文字列だけを最大3件・重複除去で採用。0件なら ["分類困難"]。
 *   ・primary   : categories に含まれる値ならそれを採用、そうでなければ categories[0]
 *                （モデルが categories と矛盾する primary を返した場合の安全側フォールバック）。
 *   ・severity  : "low"|"mid"|"high" 以外はすべて "low" に丸める（不明な重大度を過大評価しない）。
 *   ・summary   : 文字列でなければ空文字。60字を超える分は切り捨てる。
 * 入力がオブジェクトですらない（null・配列・プリミティブ・パース失敗など）場合も例外を投げず、
 * 分類困難のフォールバック一式を返す。
 */
export function normalizeClassification(raw: unknown): NormalizedClassification {
  const obj = asRecord(raw);

  let categories: string[] = [];
  if (Array.isArray(obj.categories)) {
    const seen = new Set<string>();
    for (const c of obj.categories) {
      if (categories.length >= MAX_CATEGORIES) break;
      if (typeof c === "string" && COMMENT_CATEGORY_SET.has(c) && !seen.has(c)) {
        seen.add(c);
        categories.push(c);
      }
    }
  }
  if (categories.length === 0) categories = [FALLBACK_CATEGORY];

  const primary = typeof obj.primary === "string" && categories.includes(obj.primary)
    ? obj.primary
    : categories[0];

  const severity: ClassificationSeverity =
    obj.severity === "low" || obj.severity === "mid" || obj.severity === "high" ? obj.severity : "low";

  let summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
  if (summary.length > MAX_SUMMARY_CHARS) summary = summary.slice(0, MAX_SUMMARY_CHARS);

  return { categories, primary, severity, summary };
}

// ── composeDailyDigest / composeImmediate ───────────────────────────

const MAX_MESSAGE_LENGTH = 3500;
const SEVERITY_LABEL: Record<string, string> = { critical: "重大", warn: "注意", info: "情報" };
const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 };

function normalizeSeverity(s: string | null | undefined): "critical" | "warn" | "info" {
  return s === "critical" || s === "warn" || s === "info" ? s : "info";
}

/** severity（critical→warn→info）優先、同 severity 内は rule_code でまとめる。 */
function sortAlerts(alerts: AlertDigestAlert[]): AlertDigestAlert[] {
  return [...alerts].sort((a, b) => {
    const sa = SEVERITY_RANK[normalizeSeverity(a.severity)];
    const sb = SEVERITY_RANK[normalizeSeverity(b.severity)];
    if (sa !== sb) return sa - sb;
    const ra = a.rule_code ?? "";
    const rb = b.rule_code ?? "";
    if (ra !== rb) return ra < rb ? -1 : 1;
    const na = a.name ?? a.employee_number ?? "";
    const nb = b.name ?? b.employee_number ?? "";
    if (na !== nb) return na < nb ? -1 : 1;
    return 0;
  });
}

/** 「氏名（部署）｜ルール label｜理由1行｜コメント要約」の1行（コメント要約は無ければ省略）。 */
function formatAlertLine(a: AlertDigestAlert): string {
  const name = (a.name && a.name.trim()) || a.employee_number || "(氏名不明)";
  const dept = (a.department && a.department.trim()) || "所属不明";
  const ruleLabel = (a.rule_label && a.rule_label.trim()) || a.rule_code;
  const reason = reasonLine(a.rule_code, a.reason);
  const parts = [`${name}（${dept}）`, ruleLabel, reason];
  const summary = a.comment_summary && a.comment_summary.trim();
  if (summary) parts.push(summary);
  return "• " + parts.join("｜");
}

/** severity ごとに見出し（*重大* 等）を立て、行をまとめる（rows は sortAlerts 済み前提）。 */
function renderRows(rows: AlertDigestAlert[]): string {
  const bands: string[] = [];
  let currentSeverity: string | null = null;
  let currentLines: string[] = [];
  const flush = () => {
    if (currentSeverity && currentLines.length > 0) {
      bands.push(`*${SEVERITY_LABEL[currentSeverity] ?? currentSeverity}*\n` + currentLines.join("\n"));
    }
  };
  for (const row of rows) {
    const sev = normalizeSeverity(row.severity);
    if (sev !== currentSeverity) {
      flush();
      currentSeverity = sev;
      currentLines = [];
    }
    currentLines.push(formatAlertLine(row));
  }
  flush();
  return bands.join("\n\n");
}

function buildFooter(byState: AlertDigestByState, openTotal: number, appUrl: string): string {
  const todo = byState?.todo ?? 0;
  const doing = byState?.doing ?? 0;
  const onHold = byState?.on_hold_org ?? 0;
  return `未完了 ${openTotal}件（未対応 ${todo}／対応中 ${doing}／保留 ${onHold}）\n${appUrl}/#/pulse/alerts`;
}

/**
 * batch（pulse_alert_digest_batch の返り値）と見出し文字列から本文を組む。
 * 1メッセージ 3,500 文字を超える場合は、severity/rule_code 順で末尾から間引き、
 * 「…ほか N 件」を添えて footer が必ず収まるようにする（二分探索で最大件数を決める）。
 */
function buildBody(batch: AlertDigestBatch, appUrl: string, header: string): string {
  const sorted = sortAlerts(batch.alerts ?? []);
  const footer = buildFooter(batch.by_state ?? {}, batch.open_total ?? sorted.length, appUrl);

  const render = (rows: AlertDigestAlert[], omitted: number): string => {
    const body = renderRows(rows);
    const omittedLine = omitted > 0 ? `…ほか ${omitted} 件` : "";
    return [header, body, omittedLine, footer].filter((s) => s.length > 0).join("\n\n");
  };

  const full = render(sorted, 0);
  if (full.length <= MAX_MESSAGE_LENGTH || sorted.length === 0) return full;

  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = render(sorted.slice(0, mid), sorted.length - mid);
    if (candidate.length <= MAX_MESSAGE_LENGTH) lo = mid;
    else hi = mid - 1;
  }
  return render(sorted.slice(0, lo), sorted.length - lo);
}

/** 日次ダイジェスト本文（pulse-alert-digest daily/preview 共用）。 */
export function composeDailyDigest(batch: AlertDigestBatch, appUrl: string): string {
  return buildBody(batch, appUrl, "*TalentHub パルスサーベイ アラート日次ダイジェスト*");
}

/** 即時通知本文（先頭「【即時】」固定・pulse-alert-digest immediate 用）。 */
export function composeImmediate(batch: AlertDigestBatch, appUrl: string): string {
  return buildBody(batch, appUrl, "【即時】*TalentHub パルスサーベイ アラート*");
}
