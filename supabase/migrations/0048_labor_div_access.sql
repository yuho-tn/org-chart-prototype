-- ══════════════════════════════════════════════════════════════════════
-- 0048_labor_div_access.sql
-- 人件費モジュール: DIV別（組織単位別）に切り出した閲覧専用ページ
-- （#/labor/div/:target）のメールアドレス単位アクセス許可リスト（裕鵬さん指示 2026-09-18）。
--
-- 背景: 全従業員の人件費（#/labor 本体）は laborcost_admins のみに限定済みだが、
-- DIVマネージャーには自分の担当DIVの詳細人件費だけは見せたい。そのための
-- 「DIV別ページ」を新設し、メールアドレスごとに見られる target（DIV/プール名）を
-- 許可リストで管理する。
--
-- target の8値は 5期タクソノミー（0039/0040）の comp.divs / comp.pools 名と一致させる:
--   SNS DIV / マーケティングDIV / 制作DIV / AI DIV        … comp.divs（プロダクトDIV）
--   フロントDIV / HR TM / コーポレートTM / 開発TM        … comp.pools（按分原資プール）
-- 役員（comp.divs）はこの一覧に含めない（役員報酬は対象外・laborcost_admins限定のまま）。
--
-- ★ アクセス制御: このテーブル自体は laborcost_admins の owner のみ読み書き可能
--   （既存 is_laborcost_owner を再利用）。DIV別ページの閲覧者本人はこのテーブルを
--   直接読まない＝実際の許可判定と集計は Vercel API（service_role・per-user JWT検証）
--   で行う（api/labor-div-report.ts）。テーブル名・DIV名以外の個人情報はここに持たない。
--
-- Idempotent — safe to re-run.
-- ══════════════════════════════════════════════════════════════════════

begin;

create table if not exists public.labor_div_access (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(trim(email))),
  target text not null check (target in (
    'SNS DIV', 'マーケティングDIV', '制作DIV', 'AI DIV',
    'フロントDIV', 'HR TM', 'コーポレートTM', '開発TM'
  )),
  created_at timestamptz not null default now(),
  created_by text,
  unique (email, target)
);

create index if not exists labor_div_access_target_idx on public.labor_div_access (target);

-- email 小文字正規化トリガ（laborcost_admins と同じ作法・0044踏襲）。
create or replace function public.labor_div_access_normalize_email()
returns trigger
language plpgsql
as $$
begin
  new.email := lower(trim(new.email));
  new.created_by := coalesce(new.created_by, auth.email());
  return new;
end $$;

drop trigger if exists trg_labor_div_access_normalize on public.labor_div_access;
create trigger trg_labor_div_access_normalize
  before insert or update on public.labor_div_access
  for each row execute function public.labor_div_access_normalize_email();

-- ── RLS: owner のみ読み書き可（default-deny・laborcost_admins と同じ二重防御）──
alter table public.labor_div_access enable row level security;
revoke all on table public.labor_div_access from anon;

drop policy if exists "labor_div_access all (owner)" on public.labor_div_access;
create policy "labor_div_access all (owner)"
  on public.labor_div_access for all
  using (public.is_laborcost_owner(auth.email()))
  with check (public.is_laborcost_owner(auth.email()));

commit;
