-- ─────────────────────────────────────────────────────────────────────
-- 0002_employees
--
-- Adds the public.employees master table.
--
-- Columns map to the user's spec:
--   employee_number  社員番号    PK
--   last_name        姓
--   first_name       名
--   email            メールアドレス
--   employment_type  雇用形態    (e.g. 正社員 / 業務委託 / アルバイト …)
--   department       部署
--   position_title   役職        (役職名そのもの — types.PersonRole 制約とは独立)
--   hired_at         入社日       date
--   left_at          退職日       date  (NULL の人だけ「在籍中」とみなす)
--   updated_at       自動更新タイムスタンプ
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

create table if not exists public.employees (
  employee_number text primary key,
  last_name text,
  first_name text,
  email text,
  employment_type text,
  department text,
  position_title text,
  hired_at date,
  left_at date,
  updated_at timestamptz not null default now()
);

create index if not exists employees_email_idx on public.employees (email);
create index if not exists employees_left_at_idx on public.employees (left_at);

alter table public.employees enable row level security;

drop policy if exists "anon read employees" on public.employees;
create policy "anon read employees"
  on public.employees for select using (true);

drop policy if exists "anon write employees" on public.employees;
create policy "anon write employees"
  on public.employees for all using (true) with check (true);

-- updated_at auto-touch on row update
create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists employees_touch_updated_at on public.employees;
create trigger employees_touch_updated_at
  before update on public.employees
  for each row execute function public.touch_updated_at();
