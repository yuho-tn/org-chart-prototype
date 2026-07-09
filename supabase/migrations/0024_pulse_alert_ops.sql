-- ─────────────────────────────────────────────────────────────────────
-- 0024_pulse_alert_ops
--
-- #4 パルスサーベイ スライス4（アラート一覧＋対応管理）用の RPC。
--   • pulse_list_alerts(cycle)       — can_manage_alert 保有者に scope 内アラートを
--       返す。対象者氏名は実名閲覧権(can_view_realname)でゲート（無ければ null）。
--       1アラート=1対応レコード(pulse_alert_actions)を同梱。
--   • pulse_set_alert_status(alert,status) — open/closed 切替。pulse_alerts は
--       直書きポリシー無し＝RPC専有（0021 §RLS 参照）。
--
-- 対応レコード自体の作成/更新は 0021 の insert/update RLS でクライアント直書き。
-- 「1アラート1対応」に固定するため alert_id に unique index を張る（upsert 用）。
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- 1アラート = 1対応レコード（対応管理ループ）。本番 pulse_alert_actions は0件のため安全。
create unique index if not exists pulse_alert_actions_one_per_alert
  on public.pulse_alert_actions (alert_id);

-- ── pulse_list_alerts ─────────────────────────────────────────────────
create or replace function public.pulse_list_alerts(p_cycle_id uuid)
returns table (
  alert_id uuid,
  employee_number text,
  subject_name text,          -- 実名非公開なら null（can_view_realname ゲート）
  subject_department text,
  type text,
  reason jsonb,
  status text,
  created_at timestamptz,
  action jsonb                -- 1件 or null
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_realname boolean := public.pulse_can_view_realname();
begin
  if not public.pulse_can_manage_alert() then
    raise exception 'pulse_list_alerts: permission denied';
  end if;

  return query
  select
    al.id,
    al.employee_number,
    case when v_realname
      then coalesce(e.display_name, e.full_name, al.employee_number)
      else null end,
    e.department,
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
  join public.employees e on e.employee_number = al.employee_number
  left join public.pulse_alert_actions ac on ac.alert_id = al.id
  left join public.employees ase on ase.employee_number = ac.assignee_employee_number
  where al.cycle_id = p_cycle_id
    and public.pulse_can_view_employee(al.employee_number)
  order by
    case al.status when 'open' then 0 else 1 end,
    al.created_at desc;
end;
$$;

revoke all on function public.pulse_list_alerts(uuid) from public, anon;
grant execute on function public.pulse_list_alerts(uuid) to authenticated, service_role;

-- ── pulse_set_alert_status ────────────────────────────────────────────
create or replace function public.pulse_set_alert_status(p_alert_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp text;
begin
  if p_status not in ('open','closed') then
    raise exception 'pulse_set_alert_status: invalid status %', p_status;
  end if;
  select employee_number into v_emp from public.pulse_alerts where id = p_alert_id;
  if not found then
    raise exception 'pulse_set_alert_status: alert % not found', p_alert_id;
  end if;
  if not (public.pulse_can_manage_alert() and public.pulse_can_view_employee(v_emp)) then
    raise exception 'pulse_set_alert_status: permission denied';
  end if;
  update public.pulse_alerts set status = p_status where id = p_alert_id;
end;
$$;

revoke all on function public.pulse_set_alert_status(uuid, text) from public, anon;
grant execute on function public.pulse_set_alert_status(uuid, text) to authenticated, service_role;

commit;
