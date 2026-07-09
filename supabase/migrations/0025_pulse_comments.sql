-- ─────────────────────────────────────────────────────────────────────
-- 0025_pulse_comments
--
-- #4 パルスサーベイ スライス5（コメント一覧）用の RPC。
--   pulse_list_comments(cycle) — 自由記述コメントを返す。
--     • 権限: admin OR pulse_access 保有者（集計と同じ）
--     • 実名/匿名: 投稿者名は can_view_realname でゲート（無ければ null＝匿名）
--     • 小集団 n<5 マスク: 非admin は自スコープ内の回答者数が5未満なら
--       一切返さない（コメントからの再識別を防止）。admin は scope=all で全件。
--     • scope: pulse_can_view_employee で対象を絞る
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

create or replace function public.pulse_list_comments(p_cycle_id uuid)
returns table (
  response_id uuid,
  author_name text,        -- 実名非公開なら null（匿名）
  department text,
  comment text,
  answered_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_admin boolean := public.pulse_is_admin();
  v_realname boolean := public.pulse_can_view_realname();
  v_access boolean;
  v_inscope integer;
begin
  select exists (
    select 1 from public.pulse_access
    where email = lower(coalesce(auth.email(), ''))
  ) into v_access;

  if not (v_admin or v_access) then
    raise exception 'pulse_list_comments: permission denied';
  end if;

  -- 小集団 n<5 マスク（非admin のみ）。自スコープ内の回答者が5未満なら空を返す。
  if not v_admin then
    select count(*) into v_inscope
    from public.pulse_responses r
    where r.cycle_id = p_cycle_id
      and public.pulse_can_view_employee(r.employee_number);
    if coalesce(v_inscope, 0) < 5 then
      return;
    end if;
  end if;

  return query
  select
    r.id,
    case when v_realname
      then coalesce(e.display_name, e.full_name, r.employee_number)
      else null end,
    coalesce(nullif(btrim(r.snap_department), ''), e.department),
    r.comment,
    r.answered_at
  from public.pulse_responses r
  join public.employees e on e.employee_number = r.employee_number
  where r.cycle_id = p_cycle_id
    and r.comment is not null
    and btrim(r.comment) <> ''
    and public.pulse_can_view_employee(r.employee_number)
  order by r.answered_at desc nulls last;
end;
$$;

revoke all on function public.pulse_list_comments(uuid) from public, anon;
grant execute on function public.pulse_list_comments(uuid) to authenticated, service_role;

commit;
