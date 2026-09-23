-- 0027_org_editing.sql
-- P2: 組織図の編集ロック（アドバイザリロック）＋保存時rev照合＋公式デフォルト。
-- 要件定義書 §6-1/6-2（Notion「Talent Hub 残開発要件定義」）。
--
--   - org_versions.rev        … 保存の度に +1。org_save_snapshot(expected_rev)
--                               が照合し、後勝ち上書きによるデータ消失を根絶
--                               （ロックが健全なら衝突しない安全網）。
--   - org_edit_locks          … 1ファイル1編集者。heartbeat が 90秒 途絶えたら
--                               stale＝他者が取得可能。書込みは RPC 専有。
--   - org_versions.is_default … 全員共通の「公式デフォルト組織図」。部分
--                               unique index で全体1件のみ。#/org で即表示。
--
-- 既存の org_versions UPDATE ポリシー（is_writer）は rename / 権限変更 /
-- 確定登録の直接 UPDATE が使うため温存する。スナップショット保存だけが
-- RPC（rev照合つき）へ移行する。

begin;

-- ── 1. org_versions 拡張 ─────────────────────────────────────────────
alter table public.org_versions
  add column if not exists rev integer not null default 0;
alter table public.org_versions
  add column if not exists is_default boolean not null default false;

create unique index if not exists org_versions_single_default
  on public.org_versions (is_default)
  where is_default;

-- ── 2. 編集ロックテーブル ────────────────────────────────────────────
create table if not exists public.org_edit_locks (
  version_id      uuid primary key references public.org_versions(id) on delete cascade,
  locked_by_email text not null,
  locked_at       timestamptz not null default now(),
  heartbeat_at    timestamptz not null default now()
);

alter table public.org_edit_locks enable row level security;

-- 読み取りは authenticated（「誰が編集中か」の表示用）。anon には見せない。
drop policy if exists org_edit_locks_select on public.org_edit_locks;
create policy org_edit_locks_select on public.org_edit_locks
  for select to authenticated using (true);

revoke all on public.org_edit_locks from anon;
revoke all on public.org_edit_locks from authenticated;
grant select on public.org_edit_locks to authenticated;

-- ── 3. RPC群（SECURITY DEFINER・0017方針で書込みはRPC専有） ─────────

-- ロック取得: 無ロック / 自分保持 / stale(90秒) なら取得成功。
create or replace function public.org_lock_acquire(p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.email(), ''));
  v_lock public.org_edit_locks%rowtype;
begin
  if v_email = '' or not public.is_writer(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'not_writer');
  end if;
  select * into v_lock
    from public.org_edit_locks
   where version_id = p_version_id
   for update;
  if not found
     or v_lock.locked_by_email = v_email
     or v_lock.heartbeat_at < now() - interval '90 seconds' then
    insert into public.org_edit_locks (version_id, locked_by_email)
    values (p_version_id, v_email)
    on conflict (version_id) do update
      set locked_by_email = excluded.locked_by_email,
          locked_at = now(),
          heartbeat_at = now();
    return jsonb_build_object('ok', true, 'locked_by', v_email);
  end if;
  return jsonb_build_object(
    'ok', false, 'reason', 'held',
    'locked_by', v_lock.locked_by_email,
    'heartbeat_at', v_lock.heartbeat_at
  );
end;
$$;

-- ハートビート: 自分のロックの生存延長。行が無い/他人に移った場合は null。
create or replace function public.org_lock_heartbeat(p_version_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  update public.org_edit_locks
     set heartbeat_at = now()
   where version_id = p_version_id
     and locked_by_email = lower(coalesce(auth.email(), ''))
  returning true;
$$;

-- 解放: 自分のロックのみ削除できる。
create or replace function public.org_lock_release(p_version_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  delete from public.org_edit_locks
   where version_id = p_version_id
     and locked_by_email = lower(coalesce(auth.email(), ''))
  returning true;
$$;

-- 強制引継ぎ: admin 以上（master / privileged_admin / admin）。
create or replace function public.org_lock_steal(p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.email(), ''));
begin
  if not exists (
    select 1 from public.app_users
     where email = v_email
       and role in ('master', 'privileged_admin', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  insert into public.org_edit_locks (version_id, locked_by_email)
  values (p_version_id, v_email)
  on conflict (version_id) do update
    set locked_by_email = excluded.locked_by_email,
        locked_at = now(),
        heartbeat_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

-- スナップショット保存: 生きた他人ロックがあれば拒否＋rev照合で上書き事故防止。
-- p_expected_rev が null の場合は照合スキップ（後方互換・非推奨経路）。
create or replace function public.org_save_snapshot(
  p_version_id uuid,
  p_snapshot jsonb,
  p_expected_rev integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.email(), ''));
  v_holder text;
  v_rev integer;
  v_updated timestamptz;
begin
  if v_email = '' or not public.is_writer(v_email) then
    return jsonb_build_object('ok', false, 'reason', 'not_writer');
  end if;
  select locked_by_email into v_holder
    from public.org_edit_locks
   where version_id = p_version_id
     and heartbeat_at >= now() - interval '90 seconds';
  if v_holder is not null and v_holder <> v_email then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'locked_by', v_holder);
  end if;
  update public.org_versions
     set snapshot = p_snapshot,
         rev = rev + 1,
         updated_at = now()
   where id = p_version_id
     and (p_expected_rev is null or rev = p_expected_rev)
  returning rev, updated_at into v_rev, v_updated;
  if v_rev is null then
    select rev into v_rev from public.org_versions where id = p_version_id;
    if v_rev is null then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    return jsonb_build_object('ok', false, 'reason', 'rev_conflict', 'server_rev', v_rev);
  end if;
  return jsonb_build_object('ok', true, 'rev', v_rev, 'updated_at', v_updated);
end;
$$;

-- 公式デフォルトの付替え: admin 以上。p_version_id = null で解除のみ。
create or replace function public.org_set_default(p_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.email(), ''));
begin
  if not exists (
    select 1 from public.app_users
     where email = v_email
       and role in ('master', 'privileged_admin', 'admin')
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_admin');
  end if;
  update public.org_versions set is_default = false where is_default;
  if p_version_id is not null then
    update public.org_versions set is_default = true where id = p_version_id;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- 実行権限: 認証ユーザーのみ（anon には一切出さない）。
revoke all on function public.org_lock_acquire(uuid) from public, anon;
revoke all on function public.org_lock_heartbeat(uuid) from public, anon;
revoke all on function public.org_lock_release(uuid) from public, anon;
revoke all on function public.org_lock_steal(uuid) from public, anon;
revoke all on function public.org_save_snapshot(uuid, jsonb, integer) from public, anon;
revoke all on function public.org_set_default(uuid) from public, anon;
grant execute on function public.org_lock_acquire(uuid) to authenticated;
grant execute on function public.org_lock_heartbeat(uuid) to authenticated;
grant execute on function public.org_lock_release(uuid) to authenticated;
grant execute on function public.org_lock_steal(uuid) to authenticated;
grant execute on function public.org_save_snapshot(uuid, jsonb, integer) to authenticated;
grant execute on function public.org_set_default(uuid) to authenticated;

commit;
