import { useEffect, useMemo, useState } from "react";
import { useAuthStore } from "../../store/useAuthStore";
import type { Half } from "../../lib/laborCost";
import { fmtMan } from "../../lib/laborCost";
import { DivBlock, PoolBlock, type NameResolver } from "./LaborDivTab";
import type { DivBreakdown, AllocPoolBreakdown } from "../../lib/laborCost";

/**
 * DIV別 人件費ページ（#/labor/div/:target・chrome 無し・ナビ導線なし）。
 *
 * laborcost_admins（全体管理者）に加えて labor_div_access（0048）に載っている
 * メールアドレスがこの target 1件分だけを見られる。データは api/labor-div-report が
 * サーバ側（service_role・呼び出し本人のJWT検証）で target 以外を除いて返すため、
 * このページ・このストアは他DIV・他社員のデータを一切保持しない
 * （useLaborCostStore/useEmployeesStore は使わない＝全社データへは触れない）。
 */

type ReportHalf = { months: readonly string[]; block: DivBreakdown | AllocPoolBreakdown };
type Report = {
  target: string;
  kind: "div" | "pool";
  term: string;
  generatedAt: string;
  halves: Record<Half, ReportHalf | null>;
};

type FetchState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ok"; report: Report };

// このページは自分の名前をラベル表示しない（労働コストは他社員も見えるため）。
// API から届く名前（labor_people.name）をそのまま使う＝従業員マスター突合はしない。
const nameOf: NameResolver = (_personId, fallback) => fallback;

export function LaborDivViewPage({ target }: { target: string }) {
  // App.tsx がこのルートに来る前に session の有無をゲート済み（未ログインは SignInPage）。
  const session = useAuthStore((s) => s.session);
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [half, setHalf] = useState<Half>("H1");

  useEffect(() => {
    const token = session?.access_token;
    if (!token) return; // SignInPage 側で未ログインは別途処理済み
    let cancelled = false;
    setState({ status: "loading" });
    fetch(`/api/labor-div-report?target=${encodeURIComponent(target)}&term=5`, {
      headers: { authorization: `Bearer ${token}` },
    })
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) { setState({ status: "forbidden" }); return; }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setState({ status: "error", message: body?.message ?? `HTTP ${res.status}` });
          return;
        }
        const report = (await res.json()) as Report;
        setState({ status: "ok", report });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
      });
    return () => { cancelled = true; };
  }, [session?.access_token, target]);

  if (state.status === "loading") {
    return <div className="labor-gate">確認中…</div>;
  }
  if (state.status === "forbidden") {
    return (
      <div className="labor-gate">
        <p>ページが見つかりません。</p>
        <a href="#/">TalentHub トップへ</a>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="labor-gate">
        <p>読み込みエラー: {state.message}</p>
        <a href="#/">TalentHub トップへ</a>
      </div>
    );
  }

  return <LaborDivViewContent report={state.report} half={half} setHalf={setHalf} />;
}

function LaborDivViewContent({
  report,
  half,
  setHalf,
}: {
  report: Report;
  half: Half;
  setHalf: (h: Half) => void;
}) {
  const hr = report.halves[half];
  const months = hr?.months ?? [];
  const sum = (rec: Record<string, number>) => months.reduce((s, m) => s + (rec[m] ?? 0), 0);

  const Num = ({ v, strong }: { v: number; strong?: boolean }) => (
    <td className={"labor-num" + (strong ? " labor-strong" : "")}>{fmtMan(v)}</td>
  );
  const MonthCells = ({ rec, strong }: { rec: Record<string, number>; strong?: boolean }) => (
    <>
      {months.map((m) => <Num key={m} v={rec[m] ?? 0} strong={strong} />)}
      <Num v={sum(rec)} strong />
    </>
  );

  const bonusLabel = half === "H1" ? "夏ボ" : "冬ボ";
  const groupLabel = (g: "front" | "overhead") => (g === "front" ? "フロントDIV" : "HR/開発/コーポ・その他");

  const yearLabel = useMemo(() => (half === "H1" ? "7〜12月" : "1〜6月"), [half]);

  return (
    <div className="labor-page">
      <header className="labor-header">
        <div className="labor-title">
          <span className="labor-lock">🔒</span>
          <h1>{report.target}（人件費）</h1>
        </div>
        <div className="labor-header-right">
          <a className="labor-backlink" href="#/">TalentHubへ</a>
        </div>
      </header>

      <div className="labor-nav">
        <div className="labor-halfswitch">
          <button className={"labor-btn" + (half === "H1" ? " labor-btn--on" : "")} onClick={() => setHalf("H1")}>
            上期（7〜12月）
          </button>
          <button className={"labor-btn" + (half === "H2" ? " labor-btn--on" : "")} onClick={() => setHalf("H2")}>
            下期（1〜6月）
          </button>
        </div>
        <span className="labor-note">{report.target}（{report.kind === "div" ? "DIV" : "按分原資プール"}）の{yearLabel}詳細</span>
      </div>

      <main className="labor-main">
        {!hr ? (
          <div className="labor-warn">この半期のデータはありません。</div>
        ) : (
          <table className="labor-divtable">
            <thead>
              <tr>
                <th className="labor-head-item">項目</th>
                {months.map((m) => <th key={m}>{m}月</th>)}
                <th>半期計</th>
              </tr>
            </thead>
            <tbody>
              {report.kind === "div" ? (
                <DivBlock d={hr.block as DivBreakdown} MonthCells={MonthCells} nameOf={nameOf} bonusLabel={bonusLabel} />
              ) : (
                <PoolBlock p={hr.block as AllocPoolBreakdown} groupLabel={groupLabel} MonthCells={MonthCells} nameOf={nameOf} bonusLabel={bonusLabel} />
              )}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}
