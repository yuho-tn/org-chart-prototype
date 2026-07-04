-- ─────────────────────────────────────────────────────────────────────
-- 0015_profiles_and_permissions
--
-- P1: 従業員マスターリッチ化＋権限基盤。Adds:
--   • app_users.employee_number — メール一致で employees と自動紐付け
--     （既存行 backfill + on_auth_user_created トリガ拡張）
--   • employee_profiles     — カルチャー層（全ログイン者閲覧・本人セルフ編集）。
--                             標準項目＋自由項目(custom_items)＋写真(photos)。
--   • employee_confidential — 人事機密層（役職レベル・HR限定）。自由項目のみ。
--   • position_levels       — 役職→レベルの正規化辞書（管理画面で編集）。
--                             employees.position_title の実データ distinct を
--                             既知パターンの初期レベル込みで seed（未知は 0）。
--   • module_permissions    — モジュール×操作の必要レベル（管理画面で編集）。
--   • permission_grants     — 役職レベルに依らない個別付与。
--   • SECURITY DEFINER ヘルパー:
--       current_employee_number() / current_position_level() /
--       has_module_permission(module, action)
--   • RLS — カルチャー層は authenticated 全員 SELECT・本人/権限者のみ書込み。
--           機密層は has_module_permission('profiles','view_confidential') のみ。
--           権限マスター3表の書込みは is_payroll_manager のみ。
--   • employees RLS 硬化 — 0002 の using(true) write ポリシーを廃止し、
--     書込みを master/admin/privileged_admin に限定。position_title は
--     権限判定（current_position_level）の信頼の根なので、本人が自分の
--     役職を書き換えて機密層へ到達する権限昇格穴をここで塞ぐ。
--   • Storage — private bucket `profile-photos`（本人フォルダのみ書込み可）。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. app_users.employee_number（メール一致で自動紐付け） ───────────
-- on delete set null: 従業員マスターの行削除（既存機能）を FK 違反で
-- 壊さないため。
alter table public.app_users
  add column if not exists employee_number text
    references public.employees(employee_number) on delete set null;

comment on column public.app_users.employee_number is
  'employees との紐付け。メール一致で自動セット（backfill + サインアップトリガ）。';

-- Backfill: 既存 app_users 行を employees.email との小文字一致で紐付け。
update public.app_users au
set employee_number = e.employee_number
from public.employees e
where au.employee_number is null
  and e.email is not null
  and lower(e.email) = lower(au.email);

-- on_auth_user_created トリガ拡張: 初回サインイン時に employees.email と
-- 一致すれば employee_number をセット（0012 の関数を丸ごと再定義。
-- yuho のシードロールは 0012 確定どおり privileged_admin を維持）。
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(new.email);
  v_name  text := coalesce(
    new.raw_user_meta_data->>'name',
    new.raw_user_meta_data->>'full_name',
    split_part(v_email, '@', 1)
  );
  v_empnum text;
begin
  if not public.is_allowed_email(v_email) then
    raise exception 'sign-in not allowed for domain (email=%)', v_email
      using errcode = 'P0001';
  end if;

  select employee_number into v_empnum
  from public.employees
  where email is not null and lower(email) = v_email
  limit 1;

  insert into public.app_users (email, display_name, role, employee_number)
  values (
    v_email,
    v_name,
    case when v_email = 'yuho_tn@sho-san.co.jp' then 'privileged_admin' else 'viewer' end,
    v_empnum
  )
  on conflict (email) do update
    set display_name = coalesce(public.app_users.display_name, excluded.display_name),
        employee_number = coalesce(public.app_users.employee_number, excluded.employee_number);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- 逆方向の再リンク: 「先にログイン → 後から従業員マスターに追加/メール
-- 修正」のケースで app_users.employee_number が永久 NULL にならないよう、
-- employees の INSERT / email 変更時に未リンクの app_users を紐付ける。
create or replace function public.link_app_user_by_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is null or btrim(new.email) = '' then
    return new;
  end if;
  update public.app_users
    set employee_number = new.employee_number
    where lower(email) = lower(new.email)
      and employee_number is null;
  return new;
end;
$$;

drop trigger if exists employees_link_app_user on public.employees;
create trigger employees_link_app_user
  after insert or update of email on public.employees
  for each row execute function public.link_app_user_by_email();

-- ── 2. employee_profiles（カルチャー層・1人1行） ─────────────────────
create table if not exists public.employee_profiles (
  employee_number text primary key
    references public.employees(employee_number) on delete cascade,
  nickname text,                                 -- あだ名
  specialty text,                                -- 得意領域
  bio text,                                      -- 自己紹介
  hobbies text,                                  -- 趣味
  mbti text,
  strengths jsonb not null default '[]'::jsonb,  -- ストレングスファインダー上位5（text[]相当）
  custom_items jsonb not null default '[]'::jsonb, -- [{id,label,value}] 本人が自由追加
  photos jsonb not null default '[]'::jsonb,     -- [{path,caption?}] storageパス
  avatar_path text,                              -- photos の中からアバター指定
  updated_at timestamptz not null default now(),
  updated_by_email text
);

drop trigger if exists employee_profiles_touch_updated_at on public.employee_profiles;
create trigger employee_profiles_touch_updated_at
  before update on public.employee_profiles
  for each row execute function public.touch_updated_at();

-- ── 3. employee_confidential（人事機密層・1人1行） ───────────────────
create table if not exists public.employee_confidential (
  employee_number text primary key
    references public.employees(employee_number) on delete cascade,
  items jsonb not null default '[]'::jsonb,      -- [{id,label,value}] 例: 緊急連絡先
  updated_at timestamptz not null default now(),
  updated_by_email text
);

drop trigger if exists employee_confidential_touch_updated_at on public.employee_confidential;
create trigger employee_confidential_touch_updated_at
  before update on public.employee_confidential
  for each row execute function public.touch_updated_at();

-- ── 4. position_levels（役職正規化辞書） ─────────────────────────────
create table if not exists public.position_levels (
  position_title text primary key,               -- employees.position_title の生値
  level integer not null default 0,
  label text,
  sort_order integer not null default 100
);

-- Seed: employees.position_title の実データ distinct を、既知パターンの
-- 初期レベルを計算した上で登録（on conflict do nothing なので再実行しても
-- 管理画面での運用値を上書き・再昇格しない）。
--   役員(CEO/COO/CTO/CFO/CHRO/CRO/CMO系)=90 / DM/CDM=60 / TM/CTM=40 /
--   TL/CTL=20 / UL=10 / 未知=0（管理画面で設定）
-- 英字コードは語境界 \y 付きで判定し「Admin→DM」「Consultant→UL」等の
-- 部分一致誤爆を防ぐ（日本語隣接表記は誤爆より安全側の 0 に落ちる）。
insert into public.position_levels (position_title, level)
select distinct position_title,
  case
    when position_title ~* '\y(CEO|COO|CTO|CFO|CHRO|CRO|CMO)\y'
      or position_title ~ '(代表|役員)' then 90
    when position_title ~* '\y(DM|CDM)\y'
      or position_title ~ 'ディビジョンマネージャ' then 60
    when position_title ~* '\y(TM|CTM)\y'
      or position_title ~ 'チームマネージャ' then 40
    when position_title ~* '\y(UL)\y'
      or position_title ~ '(ユニットリーダー|Unitリーダー)' then 10
    when position_title ~* '\y(TL|CTL)\y'
      or position_title ~ 'チームリーダー' then 20
    else 0
  end
from public.employees
where position_title is not null and btrim(position_title) <> ''
on conflict (position_title) do nothing;

-- ── 5. module_permissions（モジュール×操作の必要レベル） ─────────────
create table if not exists public.module_permissions (
  module text not null,
  action text not null,
  min_level integer not null,
  primary key (module, action)
);

-- 初期行。既存行は上書きしない（運用値を保持）。
-- NOTE: payroll 行は seed しない — 給与系の実 RLS は 0013 の
--       is_payroll_manager 固定で本基盤と未連動のため、設定画面に出すと
--       「変えても効かない」嘘の設定になる（連動は P2 以降で別途）。
-- NOTE: survey 行は先行定義のみ・未連動（サーベイ機能実装時に参照予定）。
insert into public.module_permissions (module, action, min_level) values
  ('profiles', 'view_confidential', 60),
  ('profiles', 'edit_any',          60),
  ('survey',   'view_realname',     90),
  ('survey',   'manage_alerts',     90)
on conflict (module, action) do nothing;

-- ── 6. permission_grants（個別付与） ─────────────────────────────────
create table if not exists public.permission_grants (
  email text not null,
  module text not null,
  action text not null,
  granted_by_email text,
  created_at timestamptz not null default now(),
  primary key (email, module, action)
);

-- ── 7. SECURITY DEFINER ヘルパー ─────────────────────────────────────
-- auth.email() → app_users.employee_number
create or replace function public.current_employee_number()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select employee_number from public.app_users
  where email = lower(coalesce(auth.email(), ''))
$$;

-- 自分の役職レベル（未紐付け・未登録役職は 0）
create or replace function public.current_position_level()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((
    select pl.level
    from public.app_users au
    join public.employees e on e.employee_number = au.employee_number
    join public.position_levels pl on pl.position_title = e.position_title
    where au.email = lower(coalesce(auth.email(), ''))
  ), 0)
$$;

-- レベル到達 OR 個別付与 OR master/privileged_admin
create or replace function public.has_module_permission(p_module text, p_action text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.current_position_level() >= coalesce((
      select min_level from public.module_permissions
      where module = p_module and action = p_action
    ), 2147483647)
    or exists (
      select 1 from public.permission_grants
      where email = lower(coalesce(auth.email(), ''))
        and module = p_module and action = p_action
    )
    or exists (
      select 1 from public.app_users
      where email = lower(coalesce(auth.email(), ''))
        and role in ('master', 'privileged_admin')
    )
$$;

-- ── 8. RLS ───────────────────────────────────────────────────────────
alter table public.employee_profiles enable row level security;
alter table public.employee_confidential enable row level security;
alter table public.position_levels enable row level security;
alter table public.module_permissions enable row level security;
alter table public.permission_grants enable row level security;

-- employee_profiles: 閲覧はログイン者全員。書込みは本人 OR
-- has_module_permission('profiles','edit_any') OR is_manager。
drop policy if exists "employee_profiles read (authenticated)" on public.employee_profiles;
create policy "employee_profiles read (authenticated)"
  on public.employee_profiles for select
  to authenticated
  using (true);

drop policy if exists "employee_profiles insert (self or editor)" on public.employee_profiles;
create policy "employee_profiles insert (self or editor)"
  on public.employee_profiles for insert
  to authenticated
  with check (
    employee_number = public.current_employee_number()
    or public.has_module_permission('profiles', 'edit_any')
    or public.is_manager(auth.email())
  );

drop policy if exists "employee_profiles update (self or editor)" on public.employee_profiles;
create policy "employee_profiles update (self or editor)"
  on public.employee_profiles for update
  to authenticated
  using (
    employee_number = public.current_employee_number()
    or public.has_module_permission('profiles', 'edit_any')
    or public.is_manager(auth.email())
  )
  with check (
    employee_number = public.current_employee_number()
    or public.has_module_permission('profiles', 'edit_any')
    or public.is_manager(auth.email())
  );

drop policy if exists "employee_profiles delete (master)" on public.employee_profiles;
create policy "employee_profiles delete (master)"
  on public.employee_profiles for delete
  to authenticated
  using (public.is_payroll_manager(auth.email()));  -- master / privileged_admin

-- employee_confidential: view_confidential 権限者のみ（一般には一切見せない）。
-- has_module_permission は master/privileged_admin を内包する。
drop policy if exists "employee_confidential all (confidential)" on public.employee_confidential;
create policy "employee_confidential all (confidential)"
  on public.employee_confidential for all
  to authenticated
  using (public.has_module_permission('profiles', 'view_confidential'))
  with check (public.has_module_permission('profiles', 'view_confidential'));

-- position_levels / module_permissions:
-- SELECT はクライアント判定用に authenticated 全員。書込みは
-- is_payroll_manager（master/privileged_admin）のみ — 権限管理画面の
-- UI ゲート canManagePermissions と一致させる。is_manager(=admin含む)を
-- 許すと admin が REST 直叩きで自己付与→機密層閲覧できる穴になるため
-- 含めない。
drop policy if exists "position_levels read (authenticated)" on public.position_levels;
create policy "position_levels read (authenticated)"
  on public.position_levels for select
  to authenticated
  using (true);

drop policy if exists "position_levels write (manager)" on public.position_levels;
drop policy if exists "position_levels write (privileged)" on public.position_levels;
create policy "position_levels write (privileged)"
  on public.position_levels for all
  to authenticated
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

drop policy if exists "module_permissions read (authenticated)" on public.module_permissions;
create policy "module_permissions read (authenticated)"
  on public.module_permissions for select
  to authenticated
  using (true);

drop policy if exists "module_permissions write (manager)" on public.module_permissions;
drop policy if exists "module_permissions write (privileged)" on public.module_permissions;
create policy "module_permissions write (privileged)"
  on public.module_permissions for all
  to authenticated
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

-- permission_grants: SELECT は「自分宛の付与」OR 権限管理者のみ
-- （他人の個別付与状況は一般ユーザーには見せない）。書込みは同上。
drop policy if exists "permission_grants read (authenticated)" on public.permission_grants;
drop policy if exists "permission_grants read (own or privileged)" on public.permission_grants;
create policy "permission_grants read (own or privileged)"
  on public.permission_grants for select
  to authenticated
  using (
    email = lower(coalesce(auth.email(), ''))
    or public.is_payroll_manager(auth.email())
  );

drop policy if exists "permission_grants write (manager)" on public.permission_grants;
drop policy if exists "permission_grants write (privileged)" on public.permission_grants;
create policy "permission_grants write (privileged)"
  on public.permission_grants for all
  to authenticated
  using (public.is_payroll_manager(auth.email()))
  with check (public.is_payroll_manager(auth.email()));

-- テーブル GRANT（0014 と同様、念のため明示）
grant select, insert, update, delete on public.employee_profiles to authenticated;
grant select, insert, update, delete on public.employee_confidential to authenticated;
grant select, insert, update, delete on public.position_levels to authenticated;
grant select, insert, update, delete on public.module_permissions to authenticated;
grant select, insert, update, delete on public.permission_grants to authenticated;

-- ── 9. employees RLS 硬化 ────────────────────────────────────────────
-- position_title は current_position_level() → has_module_permission()
-- の信頼の根。0002 の「anon write employees (using true)」を残すと、
-- 誰でも自分の役職を書き換えて機密層まで到達できる権限昇格穴になる。
-- 書込みを master / admin / privileged_admin に限定する。
-- ＝ 既存 UI の編集ゲート isOrgPowerUser（EmployeesPage の CSV 取込・
--    新規追加・inline 編集・削除）および payroll の career_track 更新
--    （master/privileged_admin）と一致するため既存機能は壊れない。
-- SELECT は現状維持（0002 の read ポリシーのまま）。
drop policy if exists "anon write employees" on public.employees;
drop policy if exists "employees write (power users)" on public.employees;
create policy "employees write (power users)"
  on public.employees for all
  to anon, authenticated
  using (public.is_manager(auth.email()) or public.is_payroll_manager(auth.email()))
  with check (public.is_manager(auth.email()) or public.is_payroll_manager(auth.email()));

-- ── 10. Storage: profile-photos（private bucket） ────────────────────
insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', false)
on conflict (id) do nothing;

-- SELECT: ログイン者全員（signed URL 発行に必要）。
-- INSERT/UPDATE/DELETE: パス先頭が current_employee_number()/ の本人 OR
-- is_manager OR edit_any 権限者（他人プロフィール編集機能と整合させる）。
--
-- ⚠ 適用注意: プロジェクトによっては storage.objects の所有者権限がなく
--   ここから下が「must be owner of table objects」で失敗することがある。
--   その場合は Dashboard の Storage > Policies UI（または SQL エディタ）で
--   同等の4ポリシーを作成すること。本ファイルは全文冪等なので、テーブル系
--   だけ適用済みの状態から再実行しても安全。
drop policy if exists "profile-photos read (authenticated)" on storage.objects;
create policy "profile-photos read (authenticated)"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'profile-photos');

drop policy if exists "profile-photos insert (own folder)" on storage.objects;
create policy "profile-photos insert (own folder)"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-photos'
    and (
      split_part(name, '/', 1) = public.current_employee_number()
      or public.is_manager(auth.email())
      or public.has_module_permission('profiles', 'edit_any')
    )
  );

drop policy if exists "profile-photos update (own folder)" on storage.objects;
create policy "profile-photos update (own folder)"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (
      split_part(name, '/', 1) = public.current_employee_number()
      or public.is_manager(auth.email())
      or public.has_module_permission('profiles', 'edit_any')
    )
  );

drop policy if exists "profile-photos delete (own folder)" on storage.objects;
create policy "profile-photos delete (own folder)"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-photos'
    and (
      split_part(name, '/', 1) = public.current_employee_number()
      or public.is_manager(auth.email())
      or public.has_module_permission('profiles', 'edit_any')
    )
  );
