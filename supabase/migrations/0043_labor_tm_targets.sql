-- ══════════════════════════════════════════════════════════════════════
-- 0043_labor_tm_targets.sql
-- 人件費モジュール（#/labor）: TM別の売上目標（裕鵬さん指示 2026-07-28）。
--
-- 目的: TMのあるDIV（マーケ=広告/AIO、AI=BAA/AXコンサル、制作=デザイン/エンジニア）で
-- 「DIV直下＝どのTMにも属さない」人（和田・高橋健・国兼 等）の人件費を、
-- そのDIVの各TMへ「売上目標比」で自動按分するための分母。
--
-- 按分の起動は個人別シートのTM欄で特別選択肢「（売上目標比で按分）」を選んだ人だけ
-- （TM未割当のアルバイト等は按分しない＝tm=null のまま）。
-- 集計(laborCost.ts)は同一DIV内のTM目標比で分割計上。DIV合計・全社総計は不変。
--
-- 構造は labor_front_targets（DIV別目標）と同型で、キーを tm にしたもの。
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.labor_tm_targets (
  term text not null references public.labor_terms(code),
  half text not null check (half in ('H1','H2')),
  tm text not null,
  sales_target numeric not null,
  updated_at timestamptz not null default now(),
  primary key (term, half, tm)
);

drop trigger if exists labor_tm_targets_touch on public.labor_tm_targets;
create trigger labor_tm_targets_touch
  before update on public.labor_tm_targets
  for each row execute function public.touch_updated_at();

alter table public.labor_tm_targets enable row level security;
revoke all on table public.labor_tm_targets from anon;

drop policy if exists "labor_tm_targets read (laborcost)" on public.labor_tm_targets;
create policy "labor_tm_targets read (laborcost)"
  on public.labor_tm_targets for select
  using (public.is_laborcost_admin(auth.email()));

drop policy if exists "labor_tm_targets write (laborcost)" on public.labor_tm_targets;
create policy "labor_tm_targets write (laborcost)"
  on public.labor_tm_targets for all
  using (public.is_laborcost_admin(auth.email()))
  with check (public.is_laborcost_admin(auth.email()));

-- ── 初期値（5期・売上計画シートより。万円）───────────────────────────
--  マーケ: DIV目標の広告/AIO内訳（上期/下期）
--  AI:     営業目標の BAA固定 / コンサル変動 の半期集計（BAA TM / AXコンサルTM）
--  制作:   デザイン/エンジニアの内訳はシートに無し → 0（裕鵬さんが設定タブで入力）
insert into public.labor_tm_targets (term, half, tm, sales_target) values
  ('5','H1','広告TM',9362), ('5','H2','広告TM',10638),
  ('5','H1','AIO TM',3745), ('5','H2','AIO TM',4255),
  ('5','H1','BAA TM',3050), ('5','H2','BAA TM',3890),
  ('5','H1','AXコンサルTM',2721), ('5','H2','AXコンサルTM',3339),
  ('5','H1','デザインTM',0), ('5','H2','デザインTM',0),
  ('5','H1','エンジニアTM',0), ('5','H2','エンジニアTM',0)
on conflict (term, half, tm) do nothing;
