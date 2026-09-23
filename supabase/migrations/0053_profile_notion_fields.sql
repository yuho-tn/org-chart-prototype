-- ─────────────────────────────────────────────────────────────────────
-- 0053_profile_notion_fields
--
-- Notion「メンバー紹介ギャラリー」のプロフィールを TalentHub へ移すため、
-- 出身地・居住地・生年月日・診断結果・ひとこと・Notion 同期情報の受け皿を
-- employee_profiles に追加する。通常のプロフィール項目は本人／権限者が書き、
-- notion_page_id / notion_synced_at は今後の Notion 取込処理が書く。
--
-- RLS・GRANT は 0015_profiles_and_permissions.sql の行単位ポリシーを
-- そのまま継承する。ポリシーは employee_number と権限関数だけを参照しており、
-- 列追加の影響を受けないため変更不要。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.employee_profiles
  add column if not exists hometown           text,
  add column if not exists residence          text,
  add column if not exists birthday           date,
  add column if not exists birthday_show_year boolean default false,
  add column if not exists mbti_identity      text,
  add column if not exists mikiwame           text,
  add column if not exists motto              text,
  add column if not exists strengths_year     text,
  add column if not exists notion_page_id     text,
  add column if not exists notion_synced_at   timestamptz;

-- PostgreSQL には ADD CONSTRAINT IF NOT EXISTS がないため、既存制約を確認して
-- から追加する。NULL は許可し、値がある場合だけ A / T に限定する。
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.employee_profiles'::regclass
      and conname = 'employee_profiles_mbti_identity_check'
  ) then
    alter table public.employee_profiles
      add constraint employee_profiles_mbti_identity_check
      check (mbti_identity is null or mbti_identity in ('A', 'T'));
  end if;
end
$$;

-- Notion から再取込する際の冪等キー。未取込行（NULL）は複数存在できる。
create unique index if not exists employee_profiles_notion_page_id_uidx
  on public.employee_profiles (notion_page_id)
  where notion_page_id is not null;
