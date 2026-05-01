-- ─────────────────────────────────────────────────────────────────────
-- 0001_users_and_permissions
--
-- Adds:
--   • app_users  — registry of who can access this tool (email-keyed)
--   • org_versions.created_by_email / is_private / grants — per-version
--     permission metadata
--
-- IMPORTANT: This migration is idempotent and safe to re-run. Apply it
-- in the Supabase SQL editor for the project that hosts this app.
--
-- The auth model is "trust-the-client" (no real Supabase Auth) — the
-- application carries the current user's email in localStorage and
-- filters versions client-side based on it. Anyone with the URL who
-- knows a registered email can act as that user. This is acceptable for
-- a prototype; production would replace it with real auth (magic link,
-- OAuth, etc.) and rebuild RLS to use auth.uid() / auth.email().
-- ─────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;

-- ── app_users ────────────────────────────────────────────────────────
create table if not exists public.app_users (
  email text primary key,
  display_name text,
  role text not null default 'editor'
    check (role in ('master', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

alter table public.app_users enable row level security;

-- Permissive policies — the app does its own filtering. Replace with
-- auth.email()-aware policies once real auth is wired up.
drop policy if exists "anon read app_users" on public.app_users;
create policy "anon read app_users"
  on public.app_users for select using (true);

drop policy if exists "anon write app_users" on public.app_users;
create policy "anon write app_users"
  on public.app_users for all using (true) with check (true);

-- ── org_versions extensions ──────────────────────────────────────────
alter table public.org_versions
  add column if not exists created_by_email text,
  add column if not exists is_private boolean not null default false,
  add column if not exists grants jsonb not null default '{}'::jsonb;

-- Help the typical "list versions visible to email X" query.
create index if not exists org_versions_created_by_email_idx
  on public.org_versions (created_by_email);

-- ── Optional bootstrap (uncomment & set your email to seed the master)
-- insert into public.app_users (email, display_name, role)
-- values ('you@example.com', 'あなたの表示名', 'master')
-- on conflict (email) do update set role = excluded.role;
