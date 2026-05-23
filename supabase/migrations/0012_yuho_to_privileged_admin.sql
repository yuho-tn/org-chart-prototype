-- ─────────────────────────────────────────────────────────────────────
-- 0012_yuho_to_privileged_admin
--
-- Per the operator's request, demote yuho_tn@sho-san.co.jp from master
-- to privileged_admin. The 0008/0009 trigger only forces 'master' on
-- INSERT (first login); existing rows are not overwritten by re-login,
-- so this UPDATE persists.
--
-- Side effects of leaving NO master in the database:
--   • Nobody can grant privileged_admin or admin to another user.
--   • Org chart and salary editing both continue working through
--     privileged_admin / admin / editor.
--   • The operator can re-promote themselves to master later via the
--     SQL editor if they need to manage other privileged users.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

update public.app_users
set role = 'privileged_admin'
where email = 'yuho_tn@sho-san.co.jp'
  and role = 'master';

-- Also update the trigger so future first-time logins by this email
-- land directly on privileged_admin instead of master.
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
    case when v_email = 'yuho_tn@sho-san.co.jp' then 'privileged_admin' else 'viewer' end
  )
  on conflict (email) do update
    set display_name = coalesce(public.app_users.display_name, excluded.display_name);

  return new;
end;
$$;
