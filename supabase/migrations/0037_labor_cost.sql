-- ─────────────────────────────────────────────────────────────────────
-- 0037_labor_cost
--
-- 社員人件費管理モジュール（#/labor・ナビ非表示・丹野専用）。
-- スプレッドシート「（禁）損益計算シート／人件費ローデータ」を移植し、
--   1) 個人別 期×半期×月次の支給額（給与・夏ボ・冬ボ）
--   2) 半期ごとの所属／兼務先／兼務率
--   3) 5期 DIV別月次按分（ボーナス6ヶ月按分・社保加算・フロント売上比按分）
-- をDB化する。
--
-- ★ アクセス制御（最重要）:
--   既存の is_payroll_manager（master/privileged_admin）より さらに狭い
--   専用許可リスト laborcost_admins（seed = yuho_tn@sho-san.co.jp のみ）。
--   全テーブル default-deny RLS。許可リスト外は SELECT すら不可。
--   anon には一切 grant しない。UI からの導線も張らない（URL直打ちのみ）。
--
-- 単位: 金額はすべて「万円」（元スプレッドシートに合わせる）。
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ══ 1. 許可リスト & ゲート関数 ═══════════════════════════════════════

create table if not exists public.laborcost_admins (
  email text primary key,
  created_at timestamptz not null default now()
);

insert into public.laborcost_admins (email)
values ('yuho_tn@sho-san.co.jp')
on conflict (email) do nothing;

create or replace function public.is_laborcost_admin(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.laborcost_admins
    where email = lower(coalesce(p_email, ''))
  )
$$;

revoke all on function public.is_laborcost_admin(text) from public, anon;
grant execute on function public.is_laborcost_admin(text) to authenticated, service_role;

-- UI ゲート用（自分がアクセス可能かだけを返す。行データは一切返さない）
create or replace function public.laborcost_can_access()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_laborcost_admin(auth.email())
$$;

revoke all on function public.laborcost_can_access() from public, anon;
grant execute on function public.laborcost_can_access() to authenticated, service_role;

-- ══ 2. 期マスター ═══════════════════════════════════════════════════
-- H1 = start_year の 7〜12月 ／ H2 = start_year+1 の 1〜6月

create table if not exists public.labor_terms (
  code text primary key,          -- '1' | '2' | '2.5' | '3' | '4' | '5'
  label text not null,            -- '1期（2021/7〜2022/6）'
  start_year int not null,        -- 2021 …
  sort_order int not null
);

insert into public.labor_terms (code, label, start_year, sort_order) values
  ('1',   '1期（2021/7〜2022/6）',   2021, 1),
  ('2',   '2期（2022/7〜2023/6）',   2022, 2),
  ('2.5', '2.5期（2023/7〜2024/6）', 2023, 3),
  ('3',   '3期（2024/7〜2025/6）',   2024, 4),
  ('4',   '4期（2025/7〜2026/6）',   2025, 5),
  ('5',   '5期（2026/7〜2027/6）',   2026, 6)
on conflict (code) do nothing;

-- ══ 3. 人件費 人名簿 ═════════════════════════════════════════════════
-- 従業員マスター(employees)とは独立の名簿（過去期の退職者は SmartHR に
-- 存在しないため）。employee_number で任意リンク。

create table if not exists public.labor_people (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,      -- シート表記そのまま（例: '赤穂（10%）'）
  employee_number text,           -- employees への任意リンク（手動突合）
  hired_at date,
  departed boolean not null default false,  -- シートのグレーアウト＝退職
  sort_order int not null default 0,        -- シートの行順
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists labor_people_touch on public.labor_people;
create trigger labor_people_touch
  before update on public.labor_people
  for each row execute function public.touch_updated_at();

-- ══ 4. 半期ごとの所属・兼務 ══════════════════════════════════════════

create table if not exists public.labor_assignments (
  person_id uuid not null references public.labor_people(id) on delete cascade,
  term text not null references public.labor_terms(code),
  half text not null check (half in ('H1','H2')),
  dept text,                      -- 所属（SNSDIV/制作TM/WEBマーケTM/コーポレート/AI/フロント）
  kenmu_dept text,                -- 兼務先
  kenmu_rate numeric not null default 0,  -- 兼務率（0〜1。兼務先へ配分する率）
  tm text,                        -- 5期〜: DIV按分出力用のTM割当（null=未割当）
  updated_at timestamptz not null default now(),
  primary key (person_id, term, half)
);

drop trigger if exists labor_assignments_touch on public.labor_assignments;
create trigger labor_assignments_touch
  before update on public.labor_assignments
  for each row execute function public.touch_updated_at();

-- ══ 5. 支給額（万円） ════════════════════════════════════════════════
-- slot: '7'〜'12' / 'BS'(夏ボ) = 上期、'1'〜'6' / 'BW'(冬ボ) = 下期

create table if not exists public.labor_amounts (
  person_id uuid not null references public.labor_people(id) on delete cascade,
  term text not null references public.labor_terms(code),
  slot text not null check (slot in ('7','8','9','10','11','12','BS','1','2','3','4','5','6','BW')),
  amount numeric not null default 0,
  is_forecast boolean not null default false,  -- true=見立て（5期下期など）
  updated_at timestamptz not null default now(),
  primary key (person_id, term, slot)
);

create index if not exists labor_amounts_term_idx on public.labor_amounts (term);

drop trigger if exists labor_amounts_touch on public.labor_amounts;
create trigger labor_amounts_touch
  before update on public.labor_amounts
  for each row execute function public.touch_updated_at();

-- ══ 6. 所属 → 出力DIV/扱い マッピング ════════════════════════════════
-- treatment: 'product'=DIVのプロダクト人件費 / 'front'=売上比按分 /
--            'corporate'=按分対象外（コーポレート費として出力）

create table if not exists public.labor_dept_map (
  term text not null references public.labor_terms(code),
  dept text not null,
  div text,                       -- 出力Div名（treatment='product' のとき必須）
  treatment text not null check (treatment in ('product','front','corporate')),
  primary key (term, dept)
);

insert into public.labor_dept_map (term, dept, div, treatment) values
  ('5', 'SNSDIV',      'SNS_Div',           'product'),
  ('5', 'WEBマーケTM', 'マーケティング_DIv', 'product'),
  ('5', '制作TM',      '制作_Div',           'product'),
  ('5', 'AI',          'AI_Div',             'product'),
  ('5', 'フロント',    null,                 'front'),
  ('5', 'コーポレート', null,                'corporate')
on conflict (term, dept) do nothing;

-- ══ 7. TMマスター（出力ローデータのTM名） ════════════════════════════

create table if not exists public.labor_tms (
  tm text primary key,
  div text not null,
  sort_order int not null default 0
);

insert into public.labor_tms (tm, div, sort_order) values
  ('SNS_インスタ運用TM', 'SNS_Div',            1),
  ('SNS_動画TM',         'SNS_Div',            2),
  ('SNS_LINETM',         'SNS_Div',            3),
  ('広告TM',             'マーケティング_DIv', 4),
  ('AIOTM',              'マーケティング_DIv', 5),
  ('WebクリエイティブTM', '制作_Div',          6),
  ('WebサポートTM',      '制作_Div',           7),
  ('開発TM',             '制作_Div',           8),
  ('AITM',               'AI_Div',             9)
on conflict (tm) do nothing;

-- ══ 8. フロント按分の分母（半期固定・DIV別売上目標 万円） ═══════════
-- 比率はアプリ側で target / sum(targets) として導出（透明性のため実額を保持）

create table if not exists public.labor_front_targets (
  term text not null references public.labor_terms(code),
  half text not null check (half in ('H1','H2')),
  div text not null,
  sales_target numeric not null,
  updated_at timestamptz not null default now(),
  primary key (term, half, div)
);

drop trigger if exists labor_front_targets_touch on public.labor_front_targets;
create trigger labor_front_targets_touch
  before update on public.labor_front_targets
  for each row execute function public.touch_updated_at();

-- 5期 DIV別売上目標（「5期 営業別・DIV別売上計画」上期/下期サマリより）
insert into public.labor_front_targets (term, half, div, sales_target) values
  ('5', 'H1', 'SNS_Div',            15448),
  ('5', 'H1', 'マーケティング_DIv', 13107),
  ('5', 'H1', '制作_Div',           11700),
  ('5', 'H1', 'AI_Div',              8671),
  ('5', 'H2', 'SNS_Div',            17552),
  ('5', 'H2', 'マーケティング_DIv', 14893),
  ('5', 'H2', '制作_Div',           13300),
  ('5', 'H2', 'AI_Div',             11329)
on conflict (term, half, div) do nothing;

-- ══ 9. 設定 ═════════════════════════════════════════════════════════

create table if not exists public.labor_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

drop trigger if exists labor_settings_touch on public.labor_settings;
create trigger labor_settings_touch
  before update on public.labor_settings
  for each row execute function public.touch_updated_at();

insert into public.labor_settings (key, value) values
  ('insurance_rate', '0.17'::jsonb)     -- 社会保険料 加算率
on conflict (key) do nothing;

-- ══ 10. 監査ログ（給与モジュールと同型・SECURITY DEFINERトリガのみ書込可） ══

create table if not exists public.labor_audit_log (
  id bigserial primary key,
  table_name text not null,
  row_id text not null,
  operation text not null check (operation in ('INSERT','UPDATE','DELETE')),
  before_value jsonb,
  after_value jsonb,
  actor_email text,
  changed_at timestamptz not null default now()
);

create index if not exists labor_audit_log_changed_idx
  on public.labor_audit_log (changed_at desc);

create or replace function public.audit_labor_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row_id text;
begin
  if tg_table_name = 'labor_amounts' then
    v_row_id := coalesce(new.person_id::text, old.person_id::text) || '::' ||
                coalesce(new.term, old.term) || '::' || coalesce(new.slot, old.slot);
  elsif tg_table_name = 'labor_assignments' then
    v_row_id := coalesce(new.person_id::text, old.person_id::text) || '::' ||
                coalesce(new.term, old.term) || '::' || coalesce(new.half, old.half);
  elsif tg_table_name = 'labor_people' then
    v_row_id := coalesce(new.id::text, old.id::text);
  else
    v_row_id := '?';
  end if;

  insert into public.labor_audit_log
    (table_name, row_id, operation, before_value, after_value, actor_email)
  values (
    tg_table_name, v_row_id, tg_op,
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end,
    auth.email()
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists labor_amounts_audit on public.labor_amounts;
create trigger labor_amounts_audit
  after insert or update or delete on public.labor_amounts
  for each row execute function public.audit_labor_change();

drop trigger if exists labor_assignments_audit on public.labor_assignments;
create trigger labor_assignments_audit
  after insert or update or delete on public.labor_assignments
  for each row execute function public.audit_labor_change();

drop trigger if exists labor_people_audit on public.labor_people;
create trigger labor_people_audit
  after insert or update or delete on public.labor_people
  for each row execute function public.audit_labor_change();

-- ══ 11. RLS（default-deny → laborcost_admins のみ） ═════════════════

alter table public.laborcost_admins    enable row level security;
alter table public.labor_terms         enable row level security;
alter table public.labor_people        enable row level security;
alter table public.labor_assignments   enable row level security;
alter table public.labor_amounts       enable row level security;
alter table public.labor_dept_map      enable row level security;
alter table public.labor_tms           enable row level security;
alter table public.labor_front_targets enable row level security;
alter table public.labor_settings      enable row level security;
alter table public.labor_audit_log     enable row level security;

-- anon には一切見せない（grant 自体を剥がす）
revoke all on table public.laborcost_admins    from anon;
revoke all on table public.labor_terms         from anon;
revoke all on table public.labor_people        from anon;
revoke all on table public.labor_assignments   from anon;
revoke all on table public.labor_amounts       from anon;
revoke all on table public.labor_dept_map      from anon;
revoke all on table public.labor_tms           from anon;
revoke all on table public.labor_front_targets from anon;
revoke all on table public.labor_settings      from anon;
revoke all on table public.labor_audit_log     from anon;

-- laborcost_admins 自体は管理者のみ read（書換えはSQLコンソールからのみ）
drop policy if exists "laborcost_admins read" on public.laborcost_admins;
create policy "laborcost_admins read"
  on public.laborcost_admins for select
  using (public.is_laborcost_admin(auth.email()));

do $$
declare t text;
begin
  foreach t in array array[
    'labor_terms','labor_people','labor_assignments','labor_amounts',
    'labor_dept_map','labor_tms','labor_front_targets','labor_settings'
  ] loop
    execute format('drop policy if exists "%s read (laborcost)" on public.%I', t, t);
    execute format(
      'create policy "%s read (laborcost)" on public.%I for select using (public.is_laborcost_admin(auth.email()))',
      t, t);
    execute format('drop policy if exists "%s write (laborcost)" on public.%I', t, t);
    execute format(
      'create policy "%s write (laborcost)" on public.%I for all using (public.is_laborcost_admin(auth.email())) with check (public.is_laborcost_admin(auth.email()))',
      t, t);
  end loop;
end $$;

-- 監査ログは read のみ（書込はトリガ＝SECURITY DEFINERのみ）
drop policy if exists "labor_audit_log read (laborcost)" on public.labor_audit_log;
create policy "labor_audit_log read (laborcost)"
  on public.labor_audit_log for select
  using (public.is_laborcost_admin(auth.email()));
