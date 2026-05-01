-- ─────────────────────────────────────────────────────────────────────
-- 0004_version_confirmation
--
-- Adds the "FIX登録" pattern: each saved org_versions row can be flagged
-- as a confirmed monthly snapshot with a YYYY-MM period label.
--   • is_confirmed     boolean (default false → drafts)
--   • confirmed_period text    (e.g. "2026-07" → "2026年7月度")
-- The UI shows two tabs: 確定版 (is_confirmed=true) and 下書き (false).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

alter table public.org_versions
  add column if not exists is_confirmed boolean not null default false,
  add column if not exists confirmed_period text;

create index if not exists org_versions_confirmed_period_idx
  on public.org_versions (is_confirmed, confirmed_period desc);
