import { useUiStore, sectionOfRoute } from "../../store/useUiStore";

const SECTION_META: Record<string, { title: string; lead: string; next: string }> = {
  salary: {
    title: "給与表",
    lead: "従業員 × 半期の決定マトリクス。在籍中の全員 × 1H1〜5H1（9期）で、各セルに等級・月額給与・評価コメントを入れていきます。",
    next: "次フェーズで実装予定: 固定列(社員番号/氏名/雇用形態/部署/役職) + 半期折りたたみ + サマリーバー(合計・前期比・予算超過判定)。",
  },
  grades: {
    title: "等級マスター",
    lead: "マネジメント / スペシャリスト / 多様な正社員 の3トラック × 階層構造の等級表。期待値・月額レンジ・職種別肩書きを管理します。",
    next: "次フェーズで実装予定: 出典シートからのseed投入、CRUD UI、各社員のtrack/grade割当。",
  },
  audit_log: {
    title: "監査ログ",
    lead: "給与・等級・期マスターへのすべての書き込みを who/when/before/after で記録。法的要件にも対応します。",
    next: "次フェーズで実装予定: 給与レコードのDBトリガー設置 + 一覧UI。",
  },
};

/**
 * Stub page used while the Payroll system is being scaffolded. Lets us
 * verify the system-switcher + header + routing wiring end-to-end before
 * any of the salary tables exist. The real pages replace these one by one.
 */
export function PayrollPlaceholder() {
  const route = useUiStore((s) => s.route);
  const section = sectionOfRoute(route);
  const meta = SECTION_META[section] ?? SECTION_META.salary;

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">{meta.title}</h1>
          <p className="page__subtitle">{meta.lead}</p>
        </div>
      </div>
      <section className="card">
        <div className="card__body">
          <p className="page__hint" style={{ margin: 0 }}>
            🚧 このページは現在準備中です。
          </p>
          <p className="page__hint" style={{ marginTop: 12, marginBottom: 0 }}>
            {meta.next}
          </p>
        </div>
      </section>
    </main>
  );
}
