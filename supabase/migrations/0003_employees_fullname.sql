-- ─────────────────────────────────────────────────────────────────────
-- 0003_employees_fullname
--
-- Collapse last_name + first_name → full_name. Some CSV exports keep
-- them as separate columns (姓 / 名), others ship a single 氏名 column.
-- Storing one combined string keeps the model simple and matches the
-- user's "1本化してインポート" directive.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.employees
  add column if not exists full_name text;

-- If the legacy columns are still present, backfill full_name from them
-- before dropping. Wrapped in a DO block so the UPDATE only runs when
-- the columns exist (otherwise it would be a parse error).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'employees'
      and column_name  = 'last_name'
  ) then
    execute $sql$
      update public.employees
      set full_name = nullif(
        trim(coalesce(last_name, '') || ' ' || coalesce(first_name, '')),
        ''
      )
      where full_name is null or full_name = ''
    $sql$;
  end if;
end $$;

alter table public.employees drop column if exists last_name;
alter table public.employees drop column if exists first_name;
