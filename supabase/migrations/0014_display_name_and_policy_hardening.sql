-- ─────────────────────────────────────────────────────────────────────
-- 0014_display_name_and_policy_hardening
--
-- 1. employees.display_name — "Talent Hub上の使用ネーム"。
--    戸籍名(full_name)とは別に、社内で使う通称名（旧姓継続利用など）を
--    保持する。例: full_name = 竹川 あきら / display_name = 柴田 あきら。
--    CSV/シート取込は display_name に触れない（取込で消えない）。
--    表示は全画面で display_name ?? full_name を使う。
--
-- 2. hr_announcements のRLSポリシーを anon / authenticated 両ロールへ
--    明示付与。0005 の旧ポリシーはロール指定なし(to public)だったが、
--    削除不能の報告があったため、ロールを明示した形で作り直し、
--    テーブルGRANTも念のため再付与する（冪等）。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- 1. 使用ネーム
alter table public.employees
  add column if not exists display_name text;

comment on column public.employees.display_name is
  'Talent Hub上の使用ネーム（通称名・旧姓など）。NULLなら full_name を表示。シート取込では上書きしない。';

-- 2. hr_announcements ポリシー明示化
alter table public.hr_announcements enable row level security;

drop policy if exists "anon read hr_announcements" on public.hr_announcements;
drop policy if exists "anon write hr_announcements" on public.hr_announcements;
drop policy if exists "hr_announcements read (all)" on public.hr_announcements;
drop policy if exists "hr_announcements write (all)" on public.hr_announcements;

create policy "hr_announcements read (all)"
  on public.hr_announcements for select
  to anon, authenticated
  using (true);

create policy "hr_announcements write (all)"
  on public.hr_announcements for all
  to anon, authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.hr_announcements to anon, authenticated;
grant select, insert, update, delete on public.employees to anon, authenticated;
