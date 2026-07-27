-- ─────────────────────────────────────────────────────────────────────
-- 0020_announcement_share_token
--
-- 人事発令の「非ログイン共有リンク」（トークンゲート）。
--
-- 背景: hr_announcements は 0017 で匿名アクセスを完全遮断（人事データの
-- ため）。一方でログイン不要な閲覧リンクを配りたいニーズがある。テーブルを
-- 匿名開放すると全件が漏れるため、代わりに「共有トークンを知っている人だけ
-- が1件だけ取得できる」SECURITY DEFINER RPC を用意する。
--
-- 発行モデル: オプトイン。share_token は既定 NULL（＝共有リンクなし）。
-- ユーザーが「共有リンクを発行」した時だけ token を採番し、「無効化（再発行）」
-- で差し替え/失効できる。公開(is_published)された発令のみ共有可能。
-- ─────────────────────────────────────────────────────────────────────

alter table public.hr_announcements
  add column if not exists share_token uuid;

-- トークンは一意（NULL は除外＝部分ユニーク）。
create unique index if not exists hr_announcements_share_token_key
  on public.hr_announcements (share_token)
  where share_token is not null;

-- 匿名がトークン一致時だけ1件取得できる RPC。テーブル権限は 0017 のまま
-- （anon 遮断）で、この関数経由でのみ限定公開する。published のみ返す。
-- 共有リンク経由の閲覧に不要な列（version_a_id / version_b_id /
-- created_by_email / share_token 自体）は返さない。
create or replace function public.announcement_by_share_token(p_token uuid)
returns table (
  id uuid,
  period text,
  title text,
  payload jsonb,
  is_published boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select a.id, a.period, a.title, a.payload, a.is_published,
         a.created_at, a.updated_at
  from public.hr_announcements a
  where a.share_token = p_token
    and a.is_published = true
$$;

revoke all on function public.announcement_by_share_token(uuid) from public;
grant execute on function public.announcement_by_share_token(uuid) to anon, authenticated;
