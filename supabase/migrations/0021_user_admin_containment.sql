-- ─────────────────────────────────────────────────────────────────────
-- 0021_user_admin_containment
--
-- 目的：ユーザー管理（追加・権限変更・削除）を「管理者以上」= master /
--       privileged_admin / admin が実施できるようにする。ただし給与・査定に
--       アクセスできる privileged_admin（および master）への昇格だけは
--       master 専任に留め、「給与アクセスを他人にばらまく」エスカレーションを
--       DB レベルで封じ込める（＝封じ込め型）。
--
-- 背景：0012 で唯一の master（yuho_tn）を privileged_admin へ降格し、DB から
--       master が消えていた。その結果：
--         • privileged_admin は is_manager(master/admin) に含まれず、
--           app_users を一切書き換えられない（＝追加も権限変更も不可）。
--         • 誰も admin/privileged_admin を任命できない。
--       本 migration は master（yuho_tn）を復帰させたうえで、app_users の
--       書き込みポリシーを「管理者以上、ただし付与できるロールに上限」へ
--       張り替える。
--
-- 権限マトリクス（post-0021）：
--   master           : 全ユーザー管理。特権管理者/管理者/編集/閲覧を任命可
--   privileged_admin : ユーザー管理可。ただし任命は「管理者以下」まで
--   admin            : ユーザー管理可。ただし任命は「管理者以下」まで
--   editor / viewer  : ユーザー管理不可
--
-- 注意：
--   • is_manager()（master/admin）は employees / hr_announcements / profiles
--     など他ポリシーが依存しているため一切変更しない。ユーザー管理専用の
--     判定は本 migration の is_user_admin() / is_master() に分離する。
--   • WITH CHECK で role='master' を一般経路から締め出す（master は
--     トリガ／SQL 管理の単一固定。UI からも任命候補に出さない）。
--   • RLS はクライアント（UsersPage）のゲートと同一制約を二重化する。UI を
--     バイパスされても DB 側で上限キャップが効く。
--
-- 冪等（再実行安全）。
-- ─────────────────────────────────────────────────────────────────────

-- 1. master（yuho_tn）を復帰。DB に master が居ないと誰も特権管理者/管理者を
--    任命できないため。
update public.app_users
set role = 'master'
where email = 'yuho_tn@sho-san.co.jp'
  and role <> 'master';

-- 2. 初回サインイン時トリガも master 固定へ戻す（自己修復）。
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

-- 3. ユーザー管理専用の判定ヘルパー（SECURITY DEFINER＝RLS 再帰回避）。
--    is_master : master のみ
--    is_user_admin : 「管理者以上」= master / privileged_admin / admin
create or replace function public.is_master(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(p_email, ''))
      and role = 'master'
  )
$$;

create or replace function public.is_user_admin(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(p_email, ''))
      and role in ('master', 'privileged_admin', 'admin')
  )
$$;

-- 4. app_users 書き込みポリシーを封じ込め型へ張り替え。
--    旧「manage app_users (master/admin only)」(0010) を drop。読み取り
--    ポリシー（0017 "app_users read (authenticated)" using(true)）は
--    そのまま＝全 authenticated が自ロール解決のため SELECT 可能。
drop policy if exists "manage app_users (master/admin only)" on public.app_users;
drop policy if exists "manage app_users (containment)" on public.app_users;

create policy "manage app_users (containment)"
  on public.app_users for all
  to authenticated
  using (
    -- 更新/削除の「対象行（既存 role）」に対する可否
    case
      when public.is_master(auth.email()) then true
      when public.is_user_admin(auth.email())
        then role in ('admin', 'editor', 'viewer')  -- 管理者以下のみ触れる
      else false
    end
  )
  with check (
    -- 追加/更新後の「新しい role」に対する上限キャップ
    case
      when public.is_master(auth.email())
        -- master は master 行の維持も含め下位ロールを自由に設定できる。
        -- ただし UI は master を任命候補に出さない（master 固定運用）。
        then role in ('master', 'privileged_admin', 'admin', 'editor', 'viewer')
      when public.is_user_admin(auth.email())
        then role in ('admin', 'editor', 'viewer')  -- 特権管理者/master へは昇格不可
      else false
    end
  );
