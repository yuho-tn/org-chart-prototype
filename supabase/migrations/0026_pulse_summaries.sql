-- ─────────────────────────────────────────────────────────────────────
-- 0026_pulse_summaries
--
-- #4 パルスサーベイ スライス6（Claude 要約）用のテーブル。
--   pulse_summaries — サイクル単位の AI 要約（1サイクル1件・最新で置換）。
--   書込みは Edge Function（service_role・RLS バイパス）専有。
--   閲覧は admin or pulse_access 保有者（集計と同じ）。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

create table if not exists public.pulse_summaries (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.pulse_cycles(id) on delete cascade,
  period text not null,
  summary text not null,
  model text,
  meta jsonb not null default '{}'::jsonb,   -- {comment_count, response_count, generated_by}
  created_at timestamptz not null default now(),
  unique (cycle_id)
);

create index if not exists pulse_summaries_period_idx
  on public.pulse_summaries (period);

alter table public.pulse_summaries enable row level security;

-- 閲覧: admin or pulse_access 保有者（ダッシュボードで表示）。書込みポリシー無し
-- ＝ authenticated からの直書き禁止（Edge Function の service_role のみ）。
drop policy if exists "pulse_summaries read (access holders)" on public.pulse_summaries;
create policy "pulse_summaries read (access holders)"
  on public.pulse_summaries for select to authenticated
  using (
    public.pulse_is_admin()
    or exists (
      select 1 from public.pulse_access
      where email = lower(coalesce(auth.email(), ''))
    )
  );

revoke all on public.pulse_summaries from anon;

commit;
