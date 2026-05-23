-- ─────────────────────────────────────────────────────────────────────
-- 0013_salary_management
--
-- Schema + seed for the Payroll system (給与・査定). Adds:
--   • Enums: career_track, grade_tier, period_code, evaluation_grade
--   • grades         — etc master (3 tracks × hierarchy), seeded from the
--                       company-wide grade/title sheet (Google Sheets
--                       1pJ2cc...) on 2026-05.
--   • periods        — 1H1〜5H1 (2022/7-12 〜 2026/7-12), seeded.
--   • employees.career_track — per-employee track assignment.
--                       Pre-fills 限定正社員 = diverse; 正社員 stays null
--                       so HR can manually pick management/specialist.
--   • salary_records — one row per (employee, period). Plain manual entry
--                       of grade / base_salary / fixed_overtime_allowance
--                       / evaluation_grade / comment. The total_monthly_
--                       salary is a generated column for cheap sums.
--   • salary_audit_log + trigger — captures every INSERT/UPDATE/DELETE
--                       on grades / periods / salary_records with the
--                       actor's email (auth.email()), before/after rows.
--   • RLS — only is_payroll_manager (master / privileged_admin) can
--           read or write any of the salary tables. Audit log is
--           append-only (no UPDATE / DELETE policy).
--   • Realtime — adds salary_records, grades, periods to the
--                 supabase_realtime publication for live collab.
--
-- Idempotent. Safe to re-run; existing data is preserved.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Enums ────────────────────────────────────────────────────────
do $$ begin
  create type public.career_track as enum ('management', 'specialist', 'diverse');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.grade_tier as enum ('officer', 'manager', 'non_manager');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.period_code as enum
    ('1H1','1H2','2H1','2H2','3H1','3H2','4H1','4H2','5H1');
exception when duplicate_object then null; end $$;

-- D, B-, etc. The Excel sheet shows letter grades; we allow the full
-- set the org may want to use without forcing a numeric coefficient
-- (the operator inputs salary by hand, so the grade is metadata).
do $$ begin
  create type public.evaluation_grade as enum
    ('S','A+','A','B+','B','B-','C','D');
exception when duplicate_object then null; end $$;

-- ── 2. employees.career_track ───────────────────────────────────────
alter table public.employees
  add column if not exists career_track public.career_track;

-- Pre-seed: 限定正社員 -> diverse track.
update public.employees
  set career_track = 'diverse'
  where employment_type = '限定正社員'
    and career_track is null;

-- ── 3. grades (等級マスター) ────────────────────────────────────────
create table if not exists public.grades (
  code text primary key,                         -- e.g. 'DM2', 'L1', 'F'
  -- NULL for non-manager grades shared across management/specialist
  career_track public.career_track,
  tier public.grade_tier not null,
  label text not null,                           -- 'ディビジョンマネージャー2'
  expectation text,
  min_monthly_salary integer,                    -- 円単位 (例: 800000)
  bonus_months numeric(3,1),                     -- 2.0, 1.5, etc
  annual_cap integer,                            -- 円単位 (例: 17000000)
  title_by_function jsonb not null default '{}'::jsonb,  -- {"frontend": "...", ...}
  sort_order integer not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists grades_track_sort_idx
  on public.grades (career_track, sort_order);

drop trigger if exists grades_touch_updated_at on public.grades;
create trigger grades_touch_updated_at
  before update on public.grades
  for each row execute function public.touch_updated_at();

-- Seed: pulled from the company-wide grade sheet on 2026-05.
-- sort_order: lower = higher rank.
insert into public.grades (code, career_track, tier, label, expectation,
  min_monthly_salary, bonus_months, annual_cap, title_by_function, sort_order)
values
  -- Officer
  ('OFF-S', null, 'officer', '役員（Senior）',
    '企業価値の最大化と持続的成長を牽引し、ステークホルダーへ説明責任を果たす最高経営層',
    null, null, null, '{}'::jsonb, 0),
  ('OFF-J', null, 'officer', '役員（Junior）',
    '複数DIVとコーポレート機能を横断統括し、短中期成長をドライブする経営層',
    900000, 3.0, 20000000, '{}'::jsonb, 10),
  -- Management track
  ('DM3', 'management', 'manager', 'ディビジョンマネージャー3',
    '事業を牽引するDIVの采配を任せられ、管轄部署自体が会社の競争優位を創出してる状態',
    800000, 2.0, 17000000, '{"frontend": "シニアプリンシパル マーケティングコンサルタント"}'::jsonb, 20),
  ('DM2', 'management', 'manager', 'ディビジョンマネージャー2',
    'DIVの采配はすべて任せられ、経営意思決定に積極関与して欲しい状態',
    800000, 2.0, 15000000, '{"frontend": "シニアプリンシパル マーケティングコンサルタント"}'::jsonb, 30),
  ('DM1', 'management', 'manager', 'ディビジョンマネージャー1',
    'DIVの采配はすべて任せられる状態',
    700000, 2.0, 13000000, '{"frontend": "プリンシパルマーケティングコンサルタント"}'::jsonb, 40),
  ('TM2', 'management', 'manager', 'チームマネージャー2',
    'TMの采配はすべて任せられる状態',
    600000, 1.5, null, '{"frontend": "エグゼクティブマーケティングコンサルタント"}'::jsonb, 50),
  ('TM1', 'management', 'manager', 'チームマネージャー1',
    '一定の助けを得ながらTMメンバーから信頼を得られている状態',
    450000, 1.5, null, '{"frontend": "エグゼクティブマーケティングコンサルタント"}'::jsonb, 60),
  -- Specialist track
  ('EP2', 'specialist', 'manager', 'エグゼクティブプレイヤー2',
    '自身のスキルセットを用いて経営意思決定に積極関与して欲しい状態',
    null, 2.0, 15000000, '{"frontend": "シニアプリンシパル マーケティングコンサルタント"}'::jsonb, 31),
  ('EP1', 'specialist', 'manager', 'エグゼクティブプレイヤー1',
    '卓越したスキルを社外に発信し、社内に持ち込める存在',
    null, 2.0, 13000000, '{"frontend": "プリンシパルマーケティングコンサルタント"}'::jsonb, 41),
  ('SP2', 'specialist', 'manager', 'スペシャルプレイヤー2',
    '担当専門領域において会社にスペシャリティをインストールできている状態',
    600000, 1.5, null, '{"frontend": "エグゼクティブマーケティングコンサルタント"}'::jsonb, 51),
  ('SP1', 'specialist', 'manager', 'スペシャルプレイヤー1',
    '担当専門領域において常に頼られる存在',
    450000, 1.5, null, '{"frontend": "エグゼクティブマーケティングコンサルタント"}'::jsonb, 61),
  -- Non-manager (common to management & specialist tracks; track left null)
  ('L2', null, 'non_manager', 'リーダー2（マネジメントリーダー）',
    'チームになくてはならない存在。常に新しい情報に敏感になり、自ら率先してチャレンジすることで率先垂範を行う',
    400000, null, null, '{"frontend": "シニアマーケティングアソシエイト"}'::jsonb, 70),
  ('L1', null, 'non_manager', 'リーダー1（アシスタントリーダー）',
    '社内で規範になって欲しいと思われる存在',
    350000, null, null, '{"frontend": "シニアマーケティングアソシエイト"}'::jsonb, 80),
  ('M3', null, 'non_manager', 'メンバー3（スタープレイヤー）',
    '社内で一目置かれる存在',
    300000, null, null, '{"frontend": "マーケティングアソシエイト"}'::jsonb, 90),
  ('M2', null, 'non_manager', 'メンバー2（メインプレイヤー）',
    '社内で戦力になっている状態',
    260000, null, null, '{"frontend": "マーケティングアソシエイト"}'::jsonb, 100),
  ('M1', null, 'non_manager', 'メンバー1（スターター）',
    'これから会社貢献してくれると期待させてくれる存在',
    200000, null, null, '{"frontend": "マーケティングアソシエイト"}'::jsonb, 110),
  -- Diverse track (多様な正社員 / 契約社員)
  ('F', 'diverse', 'manager', 'F',
    '人材管理も多大な裁量権をもって任せられる人材。アシスタントやアルバイト組織を束ねて組織化を行うことができる',
    300000, null, null, '{}'::jsonb, 200),
  ('E', 'diverse', 'non_manager', 'E',
    'チームになくてはならない人材',
    280000, null, null, '{}'::jsonb, 210),
  ('D', 'diverse', 'non_manager', 'D',
    '社内で規範になって欲しいと思われる人材',
    260000, null, null, '{}'::jsonb, 220),
  ('C', 'diverse', 'non_manager', 'C',
    '社内で一目置かれるアシスタント',
    240000, null, null, '{}'::jsonb, 230),
  ('B', 'diverse', 'non_manager', 'B',
    '社内で戦力になっているアシスタント',
    220000, null, null, '{}'::jsonb, 240),
  ('A', 'diverse', 'non_manager', 'A',
    'これから会社貢献してくれると期待させてくれるアシスタント',
    200000, null, null, '{}'::jsonb, 250)
on conflict (code) do update set
  career_track = excluded.career_track,
  tier = excluded.tier,
  label = excluded.label,
  expectation = excluded.expectation,
  min_monthly_salary = excluded.min_monthly_salary,
  bonus_months = excluded.bonus_months,
  annual_cap = excluded.annual_cap,
  title_by_function = excluded.title_by_function,
  sort_order = excluded.sort_order;

-- ── 4. periods (期マスター) ─────────────────────────────────────────
create table if not exists public.periods (
  code public.period_code primary key,
  label text not null,
  start_date date not null,
  end_date date not null,
  -- Optional: budget cap shown on the salary summary bar. When the
  -- summed monthly_salary exceeds this, the bar turns red.
  monthly_salary_budget integer,
  is_closed boolean not null default false,
  sort_order integer not null
);

-- Seed: per operator confirmation 2026-05, 1H1 = 2022年7月〜12月,
-- following 7-12 / 1-6 half-year cycles thereafter.
insert into public.periods (code, label, start_date, end_date, sort_order) values
  ('1H1','1期上期', '2022-07-01', '2022-12-31', 10),
  ('1H2','1期下期', '2023-01-01', '2023-06-30', 20),
  ('2H1','2期上期', '2023-07-01', '2023-12-31', 30),
  ('2H2','2期下期', '2024-01-01', '2024-06-30', 40),
  ('3H1','3期上期', '2024-07-01', '2024-12-31', 50),
  ('3H2','3期下期', '2025-01-01', '2025-06-30', 60),
  ('4H1','4期上期', '2025-07-01', '2025-12-31', 70),
  ('4H2','4期下期', '2026-01-01', '2026-06-30', 80),
  ('5H1','5期上期', '2026-07-01', '2026-12-31', 90)
on conflict (code) do update set
  label = excluded.label,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  sort_order = excluded.sort_order;

-- ── 5. salary_records ───────────────────────────────────────────────
create table if not exists public.salary_records (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null references public.employees(employee_number) on delete cascade,
  period public.period_code not null,
  grade_code text references public.grades(code),
  career_track public.career_track,
  evaluation_grade public.evaluation_grade,
  base_salary integer,                       -- 円単位
  fixed_overtime_allowance integer,          -- 円単位
  total_monthly_salary integer generated always as
    (coalesce(base_salary, 0) + coalesce(fixed_overtime_allowance, 0)) stored,
  comment text,
  updated_at timestamptz not null default now(),
  updated_by_email text,
  unique (employee_number, period)
);

create index if not exists salary_records_period_idx
  on public.salary_records (period);
create index if not exists salary_records_employee_idx
  on public.salary_records (employee_number);

drop trigger if exists salary_records_touch_updated_at on public.salary_records;
create trigger salary_records_touch_updated_at
  before update on public.salary_records
  for each row execute function public.touch_updated_at();

-- ── 6. salary_audit_log ─────────────────────────────────────────────
create table if not exists public.salary_audit_log (
  id bigserial primary key,
  table_name text not null,                  -- 'salary_records' | 'grades' | 'periods'
  row_id text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  before_value jsonb,
  after_value jsonb,
  actor_email text,
  changed_at timestamptz not null default now()
);

create index if not exists salary_audit_log_changed_idx
  on public.salary_audit_log (changed_at desc);

-- Generic audit trigger function. Captures row_id by reading the
-- primary key column appropriate for each tracked table.
create or replace function public.audit_payroll_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_id text;
  v_before jsonb := null;
  v_after  jsonb := null;
begin
  if TG_OP = 'DELETE' then
    v_before := to_jsonb(OLD);
    v_row_id := case TG_TABLE_NAME
      when 'salary_records' then (OLD).id::text
      when 'grades'         then (OLD).code
      when 'periods'        then (OLD).code::text
      else coalesce((OLD).id::text, '')
    end;
  elsif TG_OP = 'UPDATE' then
    v_before := to_jsonb(OLD);
    v_after  := to_jsonb(NEW);
    v_row_id := case TG_TABLE_NAME
      when 'salary_records' then (NEW).id::text
      when 'grades'         then (NEW).code
      when 'periods'        then (NEW).code::text
      else coalesce((NEW).id::text, '')
    end;
  else -- INSERT
    v_after := to_jsonb(NEW);
    v_row_id := case TG_TABLE_NAME
      when 'salary_records' then (NEW).id::text
      when 'grades'         then (NEW).code
      when 'periods'        then (NEW).code::text
      else coalesce((NEW).id::text, '')
    end;
  end if;

  insert into public.salary_audit_log
    (table_name, row_id, operation, before_value, after_value, actor_email)
  values
    (TG_TABLE_NAME, v_row_id, TG_OP, v_before, v_after, auth.email());

  return case TG_OP when 'DELETE' then OLD else NEW end;
end;
$$;

drop trigger if exists salary_records_audit on public.salary_records;
create trigger salary_records_audit
  after insert or update or delete on public.salary_records
  for each row execute function public.audit_payroll_change();

drop trigger if exists grades_audit on public.grades;
create trigger grades_audit
  after insert or update or delete on public.grades
  for each row execute function public.audit_payroll_change();

drop trigger if exists periods_audit on public.periods;
create trigger periods_audit
  after insert or update or delete on public.periods
  for each row execute function public.audit_payroll_change();

-- ── 7. RLS ──────────────────────────────────────────────────────────
alter table public.grades enable row level security;
alter table public.periods enable row level security;
alter table public.salary_records enable row level security;
alter table public.salary_audit_log enable row level security;

drop policy if exists "grades read (payroll)" on public.grades;
create policy "grades read (payroll)"
  on public.grades for select
  using (public.is_payroll_manager(auth.email()));

drop policy if exists "grades write (payroll)" on public.grades;
create policy "grades write (payroll)"
  on public.grades for all
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

drop policy if exists "periods read (payroll)" on public.periods;
create policy "periods read (payroll)"
  on public.periods for select
  using (public.is_payroll_manager(auth.email()));

drop policy if exists "periods write (payroll)" on public.periods;
create policy "periods write (payroll)"
  on public.periods for all
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

drop policy if exists "salary_records read (payroll)" on public.salary_records;
create policy "salary_records read (payroll)"
  on public.salary_records for select
  using (public.is_payroll_manager(auth.email()));

drop policy if exists "salary_records write (payroll)" on public.salary_records;
create policy "salary_records write (payroll)"
  on public.salary_records for all
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

-- Audit log: read-only for payroll managers. No write policy is created,
-- meaning ONLY the SECURITY DEFINER trigger function can insert.
drop policy if exists "salary_audit_log read (payroll)" on public.salary_audit_log;
create policy "salary_audit_log read (payroll)"
  on public.salary_audit_log for select
  using (public.is_payroll_manager(auth.email()));

-- ── 8. Realtime publication ─────────────────────────────────────────
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'salary_records'
  ) then
    alter publication supabase_realtime add table public.salary_records;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'grades'
  ) then
    alter publication supabase_realtime add table public.grades;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'periods'
  ) then
    alter publication supabase_realtime add table public.periods;
  end if;
end $$;

alter table public.salary_records replica identity full;
alter table public.grades replica identity full;
alter table public.periods replica identity full;
