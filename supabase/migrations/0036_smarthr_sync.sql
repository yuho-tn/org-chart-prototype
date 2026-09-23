-- ─────────────────────────────────────────────────────────────────────
-- 0036_smarthr_sync
--
-- SmartHR API を従業員マスター(public.employees)の「正」とする自動連携の
-- サーバ側土台。実データの取得・upsert は Edge Function `smarthr-sync`
-- (service_role) が行う。ここでは以下だけを用意する:
--   1. smarthr_can_sync()      … 同期を起動できる権限判定（従業員マスター
--                                 管理者 = master / privileged_admin / admin）
--   2. smarthr_sync_state      … 最終同期の状態を1行だけ持つシングルトン
--                                 （UI の「最終同期: …」表示用）
--
-- upsert 方針（Edge Function 側の契約・ここにメモとして固定）:
--   - 突合キー = employee_number (= SmartHR emp_code)
--   - 上書きする列: full_name / email / employment_type / department /
--                   hired_at / left_at（= resigned_at。null で在籍復帰）
--   - SmartHR に値がある時のみ上書き: position_title（大半が空のため空で
--     既存を消さない）
--   - 触らない列: display_name（旧姓・手動）/ career_track / プロフィール拡張
--   - 削除はしない（退職者は left_at で表現）
--
-- Idempotent — 何度実行しても安全。
-- ─────────────────────────────────────────────────────────────────────

-- ══ 1. 同期権限（従業員マスター管理者と同じ組: master/privileged_admin/admin） ══
create or replace function public.smarthr_can_sync()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(auth.email(), ''))
      and role in ('master', 'privileged_admin', 'admin')
  )
$$;

revoke all on function public.smarthr_can_sync() from public, anon;
grant execute on function public.smarthr_can_sync() to authenticated, service_role;

-- ══ 2. 同期状態シングルトン（id=true の1行のみ許可） ══
create table if not exists public.smarthr_sync_state (
  id boolean primary key default true check (id),
  last_run_at timestamptz,
  last_status text check (last_status in ('ok', 'error')),
  summary jsonb,
  updated_at timestamptz not null default now()
);

insert into public.smarthr_sync_state (id) values (true)
  on conflict (id) do nothing;

alter table public.smarthr_sync_state enable row level security;

-- 認証ユーザーは最終同期状況を閲覧可。書込みは service_role(Edge Function)のみ
-- ＝ 書込みポリシーを張らない（RLS 有効下では authenticated は書けない）。
drop policy if exists "authenticated read smarthr_sync_state" on public.smarthr_sync_state;
create policy "authenticated read smarthr_sync_state"
  on public.smarthr_sync_state for select
  to authenticated using (true);

revoke all on table public.smarthr_sync_state from anon;
grant select on table public.smarthr_sync_state to authenticated;
