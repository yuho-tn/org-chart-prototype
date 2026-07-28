-- ══════════════════════════════════════════════════════════════════════
-- 0042_labor_kenmu_tm.sql
-- 人件費モジュール（#/labor）: 兼務先もTM粒度で管理できるようにする（裕鵬さん指示 2026-07-28）。
--
-- これまで labor_assignments は所属側のみ tm を持ち、兼務先(kenmu_dept)は
-- DIVのみでTMを持てなかった。兼務先の按分計上をTM単位に落とすため
-- kenmu_tm 列を追加する（null=兼務先DIV直計上）。
--
-- 集計(laborCost.ts)は所属share=tm / 兼務先share=kenmu_tm を各ターゲットの
-- TMとして使う（同一DIV内のTMへ配賦）。金額の総額・DIV合計は不変で、
-- 兼務先側のTM内訳表示だけが変わる。
-- ══════════════════════════════════════════════════════════════════════

alter table public.labor_assignments
  add column if not exists kenmu_tm text;
