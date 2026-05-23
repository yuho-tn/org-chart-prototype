-- ─────────────────────────────────────────────────────────────────────
-- 0011_privileged_admin_role
--
-- Introduces the "特権管理者" (privileged_admin) role as the 5th tier
-- in the role hierarchy. Prepares the ground for the upcoming 給与・査定
-- system (talent hub の隣に並ぶ別システム) which only master and
-- privileged_admin can access.
--
-- Role matrix (post-0011):
--   master            : full access, can manage other users (固定: yuho_tn@sho-san.co.jp)
--   privileged_admin  : 組織図 full edit + 給与系 full edit
--                        × ユーザー管理は不可 (admin/master 領域)
--   admin             : 組織図 + ユーザー管理 (給与系は触れない)
--   editor            : 組織図 edit (給与系も組織編集の昇降格も範囲外)
--   viewer            : 閲覧のみ
--
-- Helper functions touched:
--   - is_writer(email)         — adds privileged_admin so they can save
--                                 org charts (parity with editor+)
--   - is_payroll_manager(email) — NEW. master / privileged_admin only.
--                                 Will be used by 0012+ RLS on salary tables.
--   - is_manager(email)         — unchanged. master/admin only. privileged_admin
--                                 deliberately excluded since they should not
--                                 be able to grant the payroll bit to others.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Expand the role check to allow privileged_admin
alter table public.app_users
  drop constraint if exists app_users_role_check;
alter table public.app_users
  add constraint app_users_role_check
  check (role in ('master', 'privileged_admin', 'admin', 'editor', 'viewer'));

-- 2. is_payroll_manager: gate for the future salary / grades / audit tables
create or replace function public.is_payroll_manager(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(p_email, ''))
      and role in ('master', 'privileged_admin')
  )
$$;

-- 3. Extend is_writer so privileged_admin can save org charts.
--    (is_manager intentionally NOT extended — privileged_admin must not
--     be able to mutate user roles.)
create or replace function public.is_writer(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(p_email, ''))
      and role in ('master', 'privileged_admin', 'admin', 'editor')
  )
$$;
