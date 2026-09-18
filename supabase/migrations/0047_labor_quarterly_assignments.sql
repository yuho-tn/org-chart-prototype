-- ══════════════════════════════════════════════════════════════════════
-- 0047_labor_quarterly_assignments.sql
-- 人件費モジュール（#/labor）: 半期(H1/H2)単位だった所属割当を
-- Q（3ヶ月）単位に細分化する（裕鵬さん指示 2026-09-18）。
--
-- 背景: これまで labor_assignments は person×term×half の1行で「半期の所属」を
-- 持っていたため、期中（Qまたぎ）の人事異動を表現できなかった。
--
-- 変更:
--   labor_assignments の主キーを (person_id, term, half) → (person_id, term, half, quarter)
--   に拡張する。quarter=1 が半期の前半3ヶ月（H1なら7〜9月=1Q、H2なら1〜3月=3Q）、
--   quarter=2 が後半3ヶ月（H1なら10〜12月=2Q、H2なら4〜6月=4Q）に対応する。
--
--   既存行はすべて quarter=1 として残したうえで、quarter=2 に同一内容を複製する
--   （1Q=2Qで所属が変わらない＝ほとんどの従業員のデフォルト状態と一致・金額は不変）。
--   期中で所属を変える場合は、アプリのUIで該当者の2Q（または4Q）だけを編集する。
--
-- 計算エンジン（src/lib/laborCost.ts computeHalf）は1Q/2Qの割当が同一なら
-- 従来どおり半期一括で計上し、異なる場合のみ3ヶ月ずつ別の所属として計上する
-- （ボーナスは変更後も 半期÷6 を維持したまま月数に応じて自然に按分される）。
--
-- Idempotent — safe to re-run.
-- ══════════════════════════════════════════════════════════════════════

begin;

-- ── 1. quarter 列を追加（既存行は既定 1 = 前半3ヶ月） ─────────────────
alter table public.labor_assignments
  add column if not exists quarter smallint not null default 1;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'labor_assignments_quarter_chk'
  ) then
    alter table public.labor_assignments
      add constraint labor_assignments_quarter_chk check (quarter in (1, 2));
  end if;
end $$;

-- ── 2. 主キーを (person_id, term, half) → (person_id, term, half, quarter) へ ──
alter table public.labor_assignments drop constraint if exists labor_assignments_pkey;

-- ── 3. 既存の quarter=1 行を quarter=2 として複製（1Q=2Q・金額保存のデフォルト） ──
-- この時点では主キーが無い（上で drop 済み）ため on conflict は使えず、
-- not exists で二重実行時の重複を防ぐ（idempotent）。
insert into public.labor_assignments
  (person_id, term, half, quarter, dept, kenmu_dept, kenmu_rate, tm, kenmu_tm)
select q1.person_id, q1.term, q1.half, 2, q1.dept, q1.kenmu_dept, q1.kenmu_rate, q1.tm, q1.kenmu_tm
from public.labor_assignments q1
where q1.quarter = 1
  and not exists (
    select 1 from public.labor_assignments q2
    where q2.person_id = q1.person_id
      and q2.term = q1.term
      and q2.half = q1.half
      and q2.quarter = 2
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.labor_assignments'::regclass and contype = 'p'
  ) then
    alter table public.labor_assignments
      add primary key (person_id, term, half, quarter);
  end if;
end $$;

commit;
