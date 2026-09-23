-- ══════════════════════════════════════════════════════════════════════
-- 0040_labor_overhead_alloc.sql
-- 人件費モジュール（#/labor）: HR TM・開発TM・コーポレートTM を
-- 「独立表示」から「按分される間接原資」に格上げする（裕鵬さん確定 2026-07-27）。
--
-- 按分は2グループに分けて各DIV（SNS/マーケ/制作/AI）へ売上目標比で計上する:
--   ・フロント按分            … プールグループ 'front'   （フロントDIV）
--   ・HR/開発/コーポ・その他按分 … プールグループ 'overhead'（HR TM/開発TM/コーポレートTM/他）
--
-- 変更（5期のみ）:
--   HR TM         product → front（alloc_group='overhead'）
--   コーポレートTM corporate → front（alloc_group='overhead'）
--   開発TM        新設 dept（front・alloc_group='overhead'）
--   フロントDIV    front のまま・プール名/グループを明示（alloc_group='front'）
--
-- 役員は対象外・独立据え置き（按分しない）。
-- 按分比率の分母は従来どおり labor_front_targets（SNS/マーケ/制作/AIの売上目標）。
-- ══════════════════════════════════════════════════════════════════════

begin;

-- ── 0. 配賦グループ列を追加（front-treatment 行の按分表示グループ）──────
alter table public.labor_dept_map
  add column if not exists alloc_group text
  check (alloc_group in ('front', 'overhead'));

-- ── 1. フロントDIV: プール名を明示し front グループへ ──────────────────
update public.labor_dept_map
  set div = 'フロントDIV', alloc_group = 'front'
  where term = '5' and dept = 'フロントDIV';

-- ── 2. HR TM: product → front（overhead グループの原資プール）──────────
update public.labor_dept_map
  set treatment = 'front', div = 'HR TM', alloc_group = 'overhead'
  where term = '5' and dept = 'HR TM';

-- ── 3. コーポレートTM: corporate → front（overhead）──────────────────
update public.labor_dept_map
  set treatment = 'front', div = 'コーポレートTM', alloc_group = 'overhead'
  where term = '5' and dept = 'コーポレートTM';

-- ── 4. 開発TM: 新設（overhead の原資プール。制作DIVから独立）──────────
insert into public.labor_dept_map (term, dept, div, treatment, sort_order, alloc_group) values
  ('5', '開発TM', '開発TM', 'front', 9, 'overhead')
on conflict (term, dept) do update
  set div = excluded.div,
      treatment = excluded.treatment,
      sort_order = excluded.sort_order,
      alloc_group = excluded.alloc_group;

commit;

-- ── 適用後の手動タスク（裕鵬さん・アプリUI上）─────────────────────────
--  ・開発TM は新設プール。開発メンバーを個人別シートで所属=開発TMに移す
--    （制作DIVから分離）。HR TM・コーポレートTM は所属そのままで按分対象化済。
--  ・各原資プール（フロント/HR/開発/コーポ）に金額計上がある前提。未計上なら
--    個人別シートで入力。
