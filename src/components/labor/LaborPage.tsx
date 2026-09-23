import { useEffect, useState } from "react";
import { useLaborCostStore } from "../../store/useLaborCostStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { useAuthStore } from "../../store/useAuthStore";
import { LaborSheetTab } from "./LaborSheetTab";
import { LaborDivTab } from "./LaborDivTab";
import { LaborRawTab } from "./LaborRawTab";
import { LaborSettingsTab } from "./LaborSettingsTab";
import { LaborAccessTab } from "./LaborAccessTab";
import { useLaborAccessStore } from "../../store/useLaborAccessStore";
import type { TermCode } from "../../lib/laborCost";

/**
 * 人件費管理（#/labor）— app シェル外のスタンドアロンページ。
 *
 * ★ このページへの導線は TalentHub のどこにも張らない（URL直打ちのみ）。
 *   アクセス可否は laborcost_can_access RPC（laborcost_admins 許可リスト）
 *   で判定し、権限がない場合はデータに一切触れず 404 相当を返す。
 *   データ自体も全テーブル RLS で許可リスト外には返らない（二重防御）。
 */

type TabKey = "sheet" | "div" | "raw" | "settings" | "access";

export function LaborPage() {
  const accessChecked = useLaborCostStore((s) => s.accessChecked);
  const canAccess = useLaborCostStore((s) => s.canAccess);
  const checkAccess = useLaborCostStore((s) => s.checkAccess);
  const load = useLaborCostStore((s) => s.load);
  const loaded = useLaborCostStore((s) => s.loaded);
  const error = useLaborCostStore((s) => s.error);
  const saveState = useLaborCostStore((s) => s.saveState);
  const saveError = useLaborCostStore((s) => s.saveError);
  const terms = useLaborCostStore((s) => s.terms);
  const flushNow = useLaborCostStore((s) => s.flushNow);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const session = useAuthStore((s) => s.session);
  const isOwner = useLaborAccessStore((s) => s.isOwner);
  const checkOwner = useLaborAccessStore((s) => s.checkOwner);

  const [tab, setTab] = useState<TabKey>("sheet");
  const [term, setTerm] = useState<TermCode>("5");
  // DIV按分/出力/設定タブは5期固定。ハイライトも実表示に合わせる（誤認防止）。
  const lockedTo5 = tab === "div" || tab === "raw" || tab === "settings";
  const effectiveTerm: TermCode = lockedTo5 ? "5" : term;

  useEffect(() => {
    void checkAccess();
  }, [checkAccess]);

  useEffect(() => {
    if (accessChecked && canAccess) {
      void load();
      void refreshEmployees({ silent: true });
      void checkOwner();
    }
  }, [accessChecked, canAccess, load, refreshEmployees, checkOwner]);

  // 離脱前に未保存分をフラッシュ
  useEffect(() => {
    const handler = () => { void flushNow(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [flushNow]);

  if (!accessChecked) {
    return <div className="labor-gate">確認中…</div>;
  }
  if (!canAccess) {
    // 権限なし: 存在を匂わせない簡素な表示のみ
    return (
      <div className="labor-gate">
        <p>ページが見つかりません。</p>
        <a href="#/">TalentHub トップへ</a>
      </div>
    );
  }

  return (
    <div className="labor-page">
      <header className="labor-header">
        <div className="labor-title">
          <span className="labor-lock">🔒</span>
          <h1>人件費管理</h1>
          <span className="labor-badge">閲覧: {session?.user?.email}（専用権限）</span>
        </div>
        <div className="labor-header-right">
          <SaveIndicator state={saveState} error={saveError} />
          <a className="labor-backlink" href="#/">TalentHubへ</a>
        </div>
      </header>

      <div className="labor-nav">
        <nav className="labor-tabs">
          <button className={tab === "sheet" ? "labor-tab labor-tab--on" : "labor-tab"} onClick={() => setTab("sheet")}>個人別シート</button>
          <button className={tab === "div" ? "labor-tab labor-tab--on" : "labor-tab"} onClick={() => setTab("div")}>DIV按分</button>
          <button className={tab === "raw" ? "labor-tab labor-tab--on" : "labor-tab"} onClick={() => setTab("raw")}>ローデータ出力</button>
          <button className={tab === "settings" ? "labor-tab labor-tab--on" : "labor-tab"} onClick={() => setTab("settings")}>設定</button>
          {isOwner && (
            <button className={tab === "access" ? "labor-tab labor-tab--on" : "labor-tab"} onClick={() => setTab("access")}>アクセス管理</button>
          )}
        </nav>
        <div className="labor-terms">
          {terms.map((t) => {
            const disabled = lockedTo5 && t.code !== "5";
            return (
              <button
                key={t.code}
                className={
                  "labor-term" +
                  (effectiveTerm === t.code ? " labor-term--on" : "") +
                  (disabled ? " labor-term--disabled" : "")
                }
                title={disabled ? "DIV按分・出力は5期のみ対応" : t.label}
                disabled={disabled}
                onClick={() => setTerm(t.code as TermCode)}
              >
                {t.code}期
              </button>
            );
          })}
        </div>
      </div>

      {error && <div className="labor-warn">読み込みエラー: {error}</div>}
      {!loaded && !error ? (
        <div className="labor-gate">読み込み中…</div>
      ) : (
        <main className="labor-main">
          {tab === "sheet" && <LaborSheetTab term={term} />}
          {tab === "div" && <LaborDivTab term="5" />}
          {tab === "raw" && <LaborRawTab term="5" />}
          {tab === "settings" && <LaborSettingsTab term="5" />}
          {tab === "access" && isOwner && <LaborAccessTab />}
        </main>
      )}
    </div>
  );
}

function SaveIndicator({ state, error }: { state: string; error: string | null }) {
  if (state === "error") {
    return <span className="labor-save labor-save--error" title={error ?? undefined}>⚠ 保存エラー（自動で再試行中）</span>;
  }
  if (state === "saving" || state === "pending") {
    return <span className="labor-save">保存中…</span>;
  }
  return <span className="labor-save labor-save--ok">✓ 保存済み</span>;
}
