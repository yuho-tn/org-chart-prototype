-- ─────────────────────────────────────────────────────────────────────
-- 0010_fix_rls_recursion
--
-- The RLS policies introduced in 0008 referenced app_users from inside
-- their own USING / WITH CHECK clauses, which causes PostgREST to return
-- HTTP 500 ("stack depth exceeded" / infinite recursion) on every
-- SELECT against app_users and (by extension) org_versions. The fix is
-- to lift the role lookup into SECURITY DEFINER helper functions that
-- run as the table owner, bypassing RLS — so the policies themselves
-- never re-enter the same table.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Drop the recursive policies
drop policy if exists "manage app_users (master/admin only)" on public.app_users;
drop policy if exists "org_versions write (editor or above)" on public.org_versions;

-- 2. Helper: master/admin ("manager") membership check
create or replace function public.is_manager(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(p_email, ''))
      and role in ('master', 'admin')
  )
$$;

-- 3. Helper: master/admin/editor ("writer") membership check
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
      and role in ('master', 'admin', 'editor')
  )
$$;

-- 4. Re-create the write policies using the helpers — no recursion now
create policy "manage app_users (master/admin only)"
  on public.app_users for all
  using (public.is_manager(auth.email()))
  with check (public.is_manager(auth.email()));

create policy "org_versions write (editor or above)"
  on public.org_versions for all
  using (public.is_writer(auth.email()))
  with check (public.is_writer(auth.email()));

-- 5. Re-assert read policies (idempotent)
drop policy if exists "read app_users (everyone)" on public.app_users;
create policy "read app_users (everyone)"
  on public.app_users for select using (true);

drop policy if exists "org_versions read (everyone)" on public.org_versions;
create policy "org_versions read (everyone)"
  on public.org_versions for select using (true);
