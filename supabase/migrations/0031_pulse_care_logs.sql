-- ─────────────────────────────────────────────────────────────────────
-- 0031_pulse_care_logs
--
-- P4-③（人起点の対応・面談ログ）。アラート起点の pulse_alert_actions は
-- 不変のまま、アラートが無くても人に紐づけて面談・声かけを記録できる
-- テーブルと RPC を追加する。個人詳細ビュー（P4-①）でアラート対応と
-- 時系列マージ表示するための per-person アラート RPC も足す。
--
--   • pulse_care_logs — id / employee_number / author_email / kind / note
--       kind: interview(面談) / outreach(声かけ) / other(その他)
--       書込み・閲覧とも can_manage_alert 権限者のみ。書込みは RPC 専有、
--       閲覧は RLS SELECT（manage_alert ＋ scope）＋一覧 RPC（氏名解決付き）。
--   • pulse_add_care_log / pulse_delete_care_log（作成者 or admin のみ削除）
--   • pulse_list_care_logs(emp) — 記録者名を解決して返す
--   • pulse_person_alerts(emp)  — 個人の全アラート＋対応レコード
--       （0024 pulse_list_alerts の per-person 版・same gate）
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 1. テーブル ══════════════════════════════════════════════════════
create table if not exists public.pulse_care_logs (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null references public.employees(employee_number),
  author_email text not null,
  kind text not null default 'interview'
    check (kind in ('interview','outreach','other')),
  note text not null,
  created_at timestamptz not null default now()
);

create index if not exists pulse_care_logs_employee_idx
  on public.pulse_care_logs (employee_number, created_at desc);

-- ══ 2. RLS / GRANT（0021 方式） ═══════════════════════════════════════
alter table public.pulse_care_logs enable row level security;

-- 閲覧: can_manage_alert かつ対象社員が scope 内。書込みポリシー無し＝RPC 専有。
drop policy if exists "pulse_care_logs read (manage_alert+scope)" on public.pulse_care_logs;
create policy "pulse_care_logs read (manage_alert+scope)"
  on public.pulse_care_logs for select to authenticated
  using (
    public.pulse_can_manage_alert()
    and public.pulse_can_view_employee(employee_number)
  );

revoke all on public.pulse_care_logs from anon;
revoke insert, update, delete on public.pulse_care_logs from authenticated;
grant select on public.pulse_care_logs to authenticated;

-- ══ 3. RPC ═══════════════════════════════════════════════════════════

-- 追加。ゲート＝can_manage_alert ＋ scope。author はサーバ側で auth.email()。
create or replace function public.pulse_add_care_log(
  p_employee_number text,
  p_kind text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_kind not in ('interview','outreach','other') then
    raise exception 'pulse_add_care_log: invalid kind %', p_kind;
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'pulse_add_care_log: note is required';
  end if;
  if not (
    public.pulse_can_manage_alert()
    and public.pulse_can_view_employee(p_employee_number)
  ) then
    raise exception 'pulse_add_care_log: permission denied';
  end if;
  if not exists (
    select 1 from public.employees where employee_number = p_employee_number
  ) then
    raise exception 'pulse_add_care_log: employee % not found', p_employee_number;
  end if;

  insert into public.pulse_care_logs (employee_number, author_email, kind, note)
  values (p_employee_number, lower(coalesce(auth.email(), '')), p_kind, btrim(p_note))
  returning id into v_id;
  return v_id;
end;
$$;

-- 削除。作成者本人 or admin のみ（誤記録の取り消し用途）。
create or replace function public.pulse_delete_care_log(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author text;
begin
  select author_email into v_author from public.pulse_care_logs where id = p_id;
  if not found then
    raise exception 'pulse_delete_care_log: log % not found', p_id;
  end if;
  if not (
    public.pulse_is_admin()
    or (public.pulse_can_manage_alert()
        and v_author = lower(coalesce(auth.email(), '')))
  ) then
    raise exception 'pulse_delete_care_log: permission denied';
  end if;
  delete from public.pulse_care_logs where id = p_id;
end;
$$;

-- 一覧（新→旧）。記録者名を employees.email 経由でベストエフォート解決。
create or replace function public.pulse_list_care_logs(p_employee_number text)
returns table (
  id uuid,
  kind text,
  note text,
  author_email text,
  author_name text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not (
    public.pulse_can_manage_alert()
    and public.pulse_can_view_employee(p_employee_number)
  ) then
    raise exception 'pulse_list_care_logs: permission denied';
  end if;

  return query
  select
    cl.id,
    cl.kind,
    cl.note,
    cl.author_email,
    (select coalesce(e.display_name, e.full_name)
     from public.employees e
     where e.left_at is null
       and coalesce(btrim(e.email), '') <> ''
       and lower(btrim(e.email)) = cl.author_email
     order by e.employee_number
     limit 1),
    cl.created_at
  from public.pulse_care_logs cl
  where cl.employee_number = p_employee_number
  order by cl.created_at desc;
end;
$$;

-- 個人の全アラート＋対応レコード（0024 pulse_list_alerts の per-person 版）。
-- ゲートも 0024 と同じ（can_manage_alert ＋ scope・氏名は返す必要がないので
-- reason / status / 対応レコードのみ）。
create or replace function public.pulse_person_alerts(p_employee_number text)
returns table (
  alert_id uuid,
  period text,
  type text,
  reason jsonb,
  status text,
  created_at timestamptz,
  action jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not (
    public.pulse_can_manage_alert()
    and public.pulse_can_view_employee(p_employee_number)
  ) then
    raise exception 'pulse_person_alerts: permission denied';
  end if;

  return query
  select
    al.id,
    c.period,
    al.type,
    al.reason,
    al.status,
    al.created_at,
    case when ac.id is null then null else jsonb_build_object(
      'id', ac.id,
      'assignee_employee_number', ac.assignee_employee_number,
      'assignee_name', case when ase.employee_number is null then null
        else coalesce(ase.display_name, ase.full_name, ase.employee_number) end,
      'state', ac.state,
      'due_date', ac.due_date,
      'note', ac.note,
      'updated_at', ac.updated_at
    ) end
  from public.pulse_alerts al
  join public.pulse_cycles c on c.id = al.cycle_id
  left join public.pulse_alert_actions ac on ac.alert_id = al.id
  left join public.employees ase on ase.employee_number = ac.assignee_employee_number
  where al.employee_number = p_employee_number
  order by al.created_at desc;
end;
$$;

-- ══ 4. 関数 GRANT ════════════════════════════════════════════════════
revoke all on function public.pulse_add_care_log(text, text, text) from public, anon;
revoke all on function public.pulse_delete_care_log(uuid) from public, anon;
revoke all on function public.pulse_list_care_logs(text) from public, anon;
revoke all on function public.pulse_person_alerts(text) from public, anon;

grant execute on function public.pulse_add_care_log(text, text, text) to authenticated, service_role;
grant execute on function public.pulse_delete_care_log(uuid) to authenticated, service_role;
grant execute on function public.pulse_list_care_logs(text) to authenticated, service_role;
grant execute on function public.pulse_person_alerts(text) to authenticated, service_role;

commit;
