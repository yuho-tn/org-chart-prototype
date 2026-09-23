-- ─────────────────────────────────────────────────────────────────────
-- 0052_user_admin_containment
--
-- 目的：ユーザー管理の権限昇格を DB レベルで封じ込める。
--
-- 現状の穴：app_users の書込ポリシーは 0010 の
--   "manage app_users (master/admin only)" … using/with check とも
--   is_manager()（= master / admin）のみで、**付与できるロールに上限が無い**。
--   そのため admin は自分や他人を privileged_admin へ昇格させられる。
--   privileged_admin は給与・査定にアクセスできる（0037 labor_* 系）ため、
--   これは「給与アクセスを誰でもばらまける」エスカレーション経路になっている。
--
-- 本 migration で「上限キャップ付き」ポリシーへ張り替える：
--   master           : 全ロールを任命可
--   privileged_admin : 任命は admin / editor / viewer まで（同格以上へは不可）
--   admin            : 任命は admin / editor / viewer まで（privileged_admin へ昇格不可）
--   editor / viewer  : ユーザー管理不可
--
-- 経緯（2026-09-23）：
--   元は 2026-07-08 に `0021_user_admin_containment.sql` として実装されたが、
--   同時期のパルス作業が同じ 0021 を取ってしまい、衝突を避けるため
--   パルス側ブランチから除外（fb76f48）された結果、**どのブランチからも
--   main へ入らないまま2ヶ月半放置**されていた。今回 main を本番実態へ
--   同期した際に発見し、現行スキーマ（0051 時点）へ合わせて書き直した。
--   ※ 当時の原文をそのまま適用すると handle_new_auth_user が 0015 以前の
--     定義へ巻き戻り、app_users.employee_number の自動リンクが壊れる。
--     ここでは 0015 の本体を維持したうえで master 既定のみ変更している。
--   採番・運用ルール → docs/BRANCHING.md
--
-- 注意：
--   • is_manager()（master/admin）は employees / hr_announcements / profiles
--     等の他ポリシーが依存しているため一切変更しない。ユーザー管理専用の
--     判定は is_user_admin() / is_master() に分離する。
--   • UI（UsersPage）のゲートは master/admin のままで本 migration より厳しい。
--     RLS は UI をバイパスされた場合の二重化として効く。
--
-- 冪等（再実行安全）。
-- ─────────────────────────────────────────────────────────────────────

-- ══ 1. master が最低1人いることを保証 ══
-- 0012 で唯一の master（yuho_tn）を privileged_admin へ降格したため、DB から
-- master が消えた時期がある。master が居ないと誰も privileged_admin を
-- 任命できず、本ポリシーが詰む。既に master ならこの UPDATE は no-op。
update public.app_users
set role = 'master'
where email = 'yuho_tn@sho-san.co.jp'
  and role <> 'master';

-- ══ 2. 初回サインイン時トリガの master 既定を戻す ══
-- 本体は 0015 の定義（employees からの employee_number 自動リンクを含む）を
-- そのまま維持し、yuho_tn の既定ロールだけ privileged_admin → master とする。
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
    case when v_email = 'yuho_tn@sho-san.co.jp' then 'master' else 'viewer' end,
    v_empnum
  )
  on conflict (email) do update
    set display_name = coalesce(public.app_users.display_name, excluded.display_name),
        employee_number = coalesce(public.app_users.employee_number, excluded.employee_number);

  return new;
end;
$$;

-- ══ 3. ユーザー管理専用の判定ヘルパー（SECURITY DEFINER＝RLS 再帰回避） ══
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

revoke all on function public.is_master(text) from public, anon;
revoke all on function public.is_user_admin(text) from public, anon;
grant execute on function public.is_master(text) to authenticated, service_role;
grant execute on function public.is_user_admin(text) to authenticated, service_role;

-- ══ 4. 書込ポリシーを封じ込め型へ張り替え ══
-- 読み取り（0017 "app_users read (authenticated)"）はそのまま。全 authenticated が
-- 自ロール解決のため SELECT できる必要がある。
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
        then role in ('admin', 'editor', 'viewer')   -- 管理者以下の行のみ触れる
      else false
    end
  )
  with check (
    -- 追加/更新後の「新しい role」に対する上限キャップ
    case
      when public.is_master(auth.email())
        then role in ('master', 'privileged_admin', 'admin', 'editor', 'viewer')
      when public.is_user_admin(auth.email())
        then role in ('admin', 'editor', 'viewer')   -- privileged_admin/master へは昇格不可
      else false
    end
  );

-- ══ 5. master 0人化の防止 ══
-- 0012 で master が消えた結果「誰も privileged_admin を任命できない」詰みが
-- 実際に発生している（本ファイル冒頭の経緯）。封じ込め型は master の存在を
-- 前提にするため、同じ詰みへ二度と入らないようトリガで塞ぐ。
-- 人件費ツールの owner 0人化拒否（0044）と同じ作法。
create or replace function public.prevent_last_master_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- master が減る操作（降格 or 削除）のときだけ検査する
  if (tg_op = 'DELETE' and old.role = 'master')
     or (tg_op = 'UPDATE' and old.role = 'master' and new.role <> 'master') then
    if not exists (
      select 1 from public.app_users
      where role = 'master'
        and email <> old.email
    ) then
      raise exception 'master を0人にはできません（最後の1人: %）', old.email
        using errcode = 'P0001';
    end if;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_prevent_last_master_removal on public.app_users;
create trigger trg_prevent_last_master_removal
  before update or delete on public.app_users
  for each row execute function public.prevent_last_master_removal();
