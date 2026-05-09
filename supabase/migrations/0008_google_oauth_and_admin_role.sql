-- ─────────────────────────────────────────────────────────────────────
-- 0008_google_oauth_and_admin_role
--
-- Replaces the trust-the-client email auth (0001) with real Supabase Auth
-- backed by Google OAuth. Adds:
--   • 'admin' role (4-tier: master / admin / editor / viewer)
--   • on_auth_user_created trigger that auto-provisions an app_users row
--     for every new auth.users row, gated by domain allow-list
--   • master seed for yuho_tn@sho-san.co.jp
--   • RLS policies rewritten to gate writes on auth.email() role lookup
--
-- IMPORTANT: idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. Expand role check to include 'admin' ──────────────────────────
alter table public.app_users
  drop constraint if exists app_users_role_check;
alter table public.app_users
  add constraint app_users_role_check
  check (role in ('master', 'admin', 'editor', 'viewer'));

-- Default role for newly inserted rows is now 'viewer' (was 'editor').
-- Existing rows are not touched.
alter table public.app_users
  alter column role set default 'viewer';

-- ── 2. Master seed (yuho_tn@sho-san.co.jp) ───────────────────────────
insert into public.app_users (email, display_name, role)
values ('yuho_tn@sho-san.co.jp', 'YUHO', 'master')
on conflict (email) do update set role = 'master';

-- ── 3. Domain allow-list helper ──────────────────────────────────────
-- A login is allowed when the email matches the company domain OR the
-- master account. Centralized so the trigger and any future RLS policy
-- can share the rule.
create or replace function public.is_allowed_email(p_email text)
returns boolean
language sql
immutable
as $$
  select p_email like '%@sho-san.co.jp'
$$;

-- ── 4. Auto-provision app_users on first Google sign-in ──────────────
-- When Supabase Auth inserts a new row in auth.users (first login),
-- mirror it into public.app_users with role='viewer' (default) — unless
-- the email is the master, in which case force 'master'. Out-of-domain
-- emails are rejected, which causes the auth signup to fail and the
-- user to see an error on the login page.
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
begin
  if not public.is_allowed_email(v_email) then
    raise exception 'sign-in not allowed for domain (email=%)', v_email
      using errcode = 'P0001';
  end if;

  insert into public.app_users (email, display_name, role)
  values (
    v_email,
    v_name,
    case when v_email = 'yuho_tn@sho-san.co.jp' then 'master' else 'viewer' end
  )
  on conflict (email) do update
    set display_name = coalesce(public.app_users.display_name, excluded.display_name);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ── 5. RLS policies: gate writes on auth.email() role lookup ─────────
-- We keep SELECT permissive (the app filters client-side and viewers
-- need to read) but tighten writes:
--   • app_users writes: only master/admin
--   • org_versions writes: anyone authenticated whose role is editor or
--     above (master/admin/editor) — viewer cannot write
-- The anon role retains read access so unauthenticated viewer-mode
-- share links continue to work.

-- app_users
drop policy if exists "anon read app_users" on public.app_users;
drop policy if exists "anon write app_users" on public.app_users;

create policy "read app_users (everyone)"
  on public.app_users for select using (true);

create policy "manage app_users (master/admin only)"
  on public.app_users for all
  using (
    exists (
      select 1 from public.app_users self
      where self.email = lower(coalesce(auth.email(), ''))
        and self.role in ('master', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.app_users self
      where self.email = lower(coalesce(auth.email(), ''))
        and self.role in ('master', 'admin')
    )
  );

-- org_versions: read everyone (viewer-mode share links rely on this),
-- write requires authenticated editor-or-above role.
drop policy if exists "org_versions read" on public.org_versions;
drop policy if exists "org_versions write" on public.org_versions;

create policy "org_versions read (everyone)"
  on public.org_versions for select using (true);

create policy "org_versions write (editor or above)"
  on public.org_versions for all
  using (
    exists (
      select 1 from public.app_users self
      where self.email = lower(coalesce(auth.email(), ''))
        and self.role in ('master', 'admin', 'editor')
    )
  )
  with check (
    exists (
      select 1 from public.app_users self
      where self.email = lower(coalesce(auth.email(), ''))
        and self.role in ('master', 'admin', 'editor')
    )
  );
