-- ─────────────────────────────────────────────────────────────────────
-- 0009_master_to_shosan
--
-- Migrates the fixed master account from yuho_tn@forumyu.co.jp
-- (provisional during initial setup) to yuho_tn@sho-san.co.jp.
--
-- Drops the forumyu.co.jp special case in the domain allow-list now
-- that the master is also a sho-san.co.jp account; the function becomes
-- a clean "@sho-san.co.jp only" check.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- 1. Remove the old master row (if it was seeded by 0008)
delete from public.app_users
where email = 'yuho_tn@forumyu.co.jp';

-- 2. Seed the new master
insert into public.app_users (email, display_name, role)
values ('yuho_tn@sho-san.co.jp', 'YUHO', 'master')
on conflict (email) do update set role = 'master';

-- 3. Tighten domain allow-list to sho-san.co.jp only
create or replace function public.is_allowed_email(p_email text)
returns boolean
language sql
immutable
as $$
  select p_email like '%@sho-san.co.jp'
$$;

-- 4. Update the new-user trigger so the master rule keys off the new
--    email. Body otherwise identical to 0008's version.
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
