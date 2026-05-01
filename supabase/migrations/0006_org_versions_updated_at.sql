-- ─────────────────────────────────────────────────────────────────────
-- 0006_org_versions_updated_at
--
-- Adds an `updated_at` column to org_versions plus an auto-touch trigger.
-- The model has shifted from "saves create new versions" to "files you
-- edit and overwrite", so we need to know when a file was last saved.
-- created_at stays as the original creation time.
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────

alter table public.org_versions
  add column if not exists updated_at timestamptz not null default now();

-- Reuse / re-create the helper from migration 0002 if it isn't around.
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists org_versions_touch_updated_at on public.org_versions;
create trigger org_versions_touch_updated_at
  before update on public.org_versions
  for each row execute function public.touch_updated_at();
