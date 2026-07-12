-- ─────────────────────────────────────────────────────────────────────
-- 0033_ai_levels
--
-- AI活用レベル（7段階認定制度・2026-07-13 YUHO確定）のデータ基盤。
--   L1 USER / L2 DRIVER / L3 HACKER / L4 BUILDER / L5 COMMANDER /
--   L6 CREATOR / L7 GAME CHANGER
--
--   • ai_level_grants — 認定付与の履歴（1行=1付与）。現在レベルは
--       当人の grants の max(level) をクライアント側で集計する
--       （レベルは失効なし＝上がるだけ、なので履歴の max で常に正しい）。
--       kind: provisional(仮認定) / official(本認定)。
--   • RLS: SELECT=authenticated 全員（個人レベルは全社フルオープン）。
--       INSERT/UPDATE/DELETE=管理者（app_users.role が master /
--       privileged_admin）のみ — ai_level_is_admin() SECURITY DEFINER
--       ヘルパー経由（0021 pulse_is_admin と同型・pulse に依存させない
--       ため独立定義）。anon は全遮断（0017 方式）。
--   • created_by は BEFORE INSERT トリガで auth.email() をサーバ側
--       スタンプ（クライアント申告値は無視＝改ざん不可）。
--
-- ⚠️ 適用手順の注意:
--   0032_pulse_production_activation.sql は manual/ 隔離を経て
--   2026-07-13 に承認適用済み（commit 9f3196c で migrations/ に復帰）。
--   ただし既存 migration 群は SQL Editor 直貼りで適用されてきており、
--   リモートの supabase_migrations 履歴との整合は未確認。`supabase db push`
--   は履歴のズレた過去ファイルを巻き込む恐れがあるため使わず、本ファイルも
--   Supabase Dashboard の SQL Editor に単独で貼り付けて実行すること
--   （idempotent・再実行安全）。
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 1. 管理者判定ヘルパー ════════════════════════════════════════════
-- 0021 pulse_is_admin() と同じ判定（master / privileged_admin）。
-- AIレベル制度を pulse スキーマ命名に依存させないため独立に定義する。
create or replace function public.ai_level_is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(auth.email(), ''))
      and role in ('master', 'privileged_admin')
  )
$$;

revoke all on function public.ai_level_is_admin() from public, anon;
grant execute on function public.ai_level_is_admin() to authenticated, service_role;

-- ══ 2. テーブル ══════════════════════════════════════════════════════
create table if not exists public.ai_level_grants (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null references public.employees(employee_number),
  level int not null check (level between 1 and 7),
  kind text not null check (kind in ('provisional','official')),
  certified_at date not null,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists ai_level_grants_employee_idx
  on public.ai_level_grants (employee_number, level desc);

create index if not exists ai_level_grants_created_idx
  on public.ai_level_grants (created_at desc);

-- created_by はサーバ側で auth.email() を強制スタンプ。
create or replace function public.ai_level_grants_stamp_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  NEW.created_by := lower(coalesce(auth.email(), ''));
  return NEW;
end;
$$;

drop trigger if exists ai_level_grants_stamp_author on public.ai_level_grants;
create trigger ai_level_grants_stamp_author
  before insert on public.ai_level_grants
  for each row execute function public.ai_level_grants_stamp_author();

-- ══ 3. RLS / GRANT（0017/0021 方式） ═════════════════════════════════
alter table public.ai_level_grants enable row level security;

-- 閲覧: ログインユーザー全員（個人レベルは全社フルオープン方針）。
drop policy if exists "ai_level_grants read (all authenticated)" on public.ai_level_grants;
create policy "ai_level_grants read (all authenticated)"
  on public.ai_level_grants for select to authenticated
  using (true);

-- 書込み: 管理者のみ（個別付与・一括投入・誤登録行の削除）。
drop policy if exists "ai_level_grants insert (admin)" on public.ai_level_grants;
create policy "ai_level_grants insert (admin)"
  on public.ai_level_grants for insert to authenticated
  with check (public.ai_level_is_admin());

drop policy if exists "ai_level_grants update (admin)" on public.ai_level_grants;
create policy "ai_level_grants update (admin)"
  on public.ai_level_grants for update to authenticated
  using (public.ai_level_is_admin())
  with check (public.ai_level_is_admin());

drop policy if exists "ai_level_grants delete (admin)" on public.ai_level_grants;
create policy "ai_level_grants delete (admin)"
  on public.ai_level_grants for delete to authenticated
  using (public.ai_level_is_admin());

revoke all on public.ai_level_grants from anon;
grant select, insert, update, delete on public.ai_level_grants to authenticated;

commit;
