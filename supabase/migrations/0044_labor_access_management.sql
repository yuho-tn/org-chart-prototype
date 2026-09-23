-- ─────────────────────────────────────────────────────────────────────
-- 0044_labor_access_management
--
-- 人件費管理（#/labor）のアクセス権限を UI から管理できるようにする。
--
-- ★ 2段階ロール:
--   - owner  … データ閲覧 ＋ アクセスリスト(laborcost_admins)の追加/削除ができる
--   - viewer … データ閲覧のみ（リストは編集不可・管理UIは非表示）
--
--   is_laborcost_admin（＝アクセス可否）は owner/viewer どちらでも true のまま。
--   リスト書き換えは is_laborcost_owner でのみ許可（RLS＋UIの二重防御を踏襲）。
--
-- ★ ロックアウト防止: owner が 0 人になる操作は必ず失敗させる（トリガ）。
-- ★ email は常に小文字で保存（is_laborcost_admin が lower() 比較のため）。
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ══ 1. role 列の追加 ═══════════════════════════════════════════════════
alter table public.laborcost_admins
  add column if not exists role text not null default 'viewer';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'laborcost_admins_role_chk'
  ) then
    alter table public.laborcost_admins
      add constraint laborcost_admins_role_chk check (role in ('owner', 'viewer'));
  end if;
end $$;

-- 既存 seed（丹野）を owner に昇格 ＋ 髙谷を owner で追加。
update public.laborcost_admins set role = 'owner' where email = 'yuho_tn@sho-san.co.jp';
insert into public.laborcost_admins (email, role)
values ('ikki_takatani@sho-san.co.jp', 'owner')
on conflict (email) do update set role = 'owner';

-- ══ 2. email 小文字正規化トリガ ═══════════════════════════════════════
create or replace function public.laborcost_admins_normalize_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  return new;
end $$;

drop trigger if exists trg_laborcost_admins_normalize on public.laborcost_admins;
create trigger trg_laborcost_admins_normalize
  before insert or update on public.laborcost_admins
  for each row execute function public.laborcost_admins_normalize_email();

-- ══ 3. ロックアウト防止トリガ（owner を 0 人にしない） ══════════════════
create or replace function public.laborcost_admins_guard_last_owner()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.laborcost_admins where role = 'owner') = 0 then
    raise exception '管理者(owner)を0人にはできません（最後の1人は削除・降格不可）';
  end if;
  return null;
end $$;

-- 行レベル AFTER なら操作後の状態を見て判定できる（経路を問わず0人化を阻止）。
drop trigger if exists trg_laborcost_admins_guard_owner on public.laborcost_admins;
create constraint trigger trg_laborcost_admins_guard_owner
  after update or delete on public.laborcost_admins
  deferrable initially immediate
  for each row execute function public.laborcost_admins_guard_last_owner();

-- ══ 4. owner 判定関数 ═══════════════════════════════════════════════════
create or replace function public.is_laborcost_owner(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.laborcost_admins
    where email = lower(coalesce(p_email, '')) and role = 'owner'
  )
$$;

revoke all on function public.is_laborcost_owner(text) from public, anon;
grant execute on function public.is_laborcost_owner(text) to authenticated, service_role;

-- UI ゲート用（自分が owner かだけを返す）
create or replace function public.laborcost_is_owner()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_laborcost_owner(auth.email())
$$;

revoke all on function public.laborcost_is_owner() from public, anon;
grant execute on function public.laborcost_is_owner() to authenticated, service_role;

-- ══ 5. RLS: リスト書き込みは owner のみ（read は既存＝全admin） ══════════
-- read ポリシーは 0037 の "laborcost_admins read"（is_laborcost_admin）を踏襲。
drop policy if exists "laborcost_admins insert" on public.laborcost_admins;
create policy "laborcost_admins insert"
  on public.laborcost_admins for insert
  with check (public.is_laborcost_owner(auth.email()));

drop policy if exists "laborcost_admins update" on public.laborcost_admins;
create policy "laborcost_admins update"
  on public.laborcost_admins for update
  using (public.is_laborcost_owner(auth.email()))
  with check (public.is_laborcost_owner(auth.email()));

drop policy if exists "laborcost_admins delete" on public.laborcost_admins;
create policy "laborcost_admins delete"
  on public.laborcost_admins for delete
  using (public.is_laborcost_owner(auth.email()));
