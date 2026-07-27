-- ─────────────────────────────────────────────────────────────────────
-- 0029_pulse_person_history
--
-- P4-①（パルス Geppo差分: 個人別回答推移ビュー）用の RPC 2本。
--   • pulse_list_member_summaries() — 在籍社員ごとの直近回答推移サマリ。
--       メンバー一覧（最新天気・トレンド矢印・連続下降フラグの元データ）。
--   • pulse_person_history(emp)     — 1人の全サイクル回答履歴
--       （総合スコア・カテゴリ別・コメント）。個人詳細の時系列チャート用。
--
-- ゲートは両方とも pulse_can_view_realname()（現行方針: 実名閲覧は役員のみ。
-- 上長・HR は不可）＋ pulse_can_view_employee() の scope。個人を特定できる
-- 生スコアを返すため、集計系（pulse_access 保有者全員）より厳しい。
-- 3ヶ月連続下降などの判定はクライアント側（lib/pulse.ts）で行う。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ── pulse_list_member_summaries ───────────────────────────────────────
-- 在籍社員（scope 内）を全員返す（未回答者も含む＝未回答も要ケア情報）。
-- history は直近6サイクル分の {period, overall, answered_at} を古→新で持つ。
-- overall は nps / 自由記述を除いた weather5・scale の平均（5点満点）。
create or replace function public.pulse_list_member_summaries()
returns table (
  employee_number text,
  name text,
  department text,
  position_title text,
  history jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not public.pulse_can_view_realname() then
    raise exception 'pulse_list_member_summaries: permission denied';
  end if;

  return query
  select
    e.employee_number,
    coalesce(e.display_name, e.full_name, e.employee_number),
    e.department,
    e.position_title,
    coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'period', h.period,
                 'overall', h.overall,
                 'answered_at', h.answered_at)
               order by h.period)
      from (
        select c.period,
               round(avg(a.score::numeric) filter (
                 where a.score is not null and q.type in ('weather5','scale')), 3) as overall,
               r.answered_at
        from public.pulse_responses r
        join public.pulse_cycles c on c.id = r.cycle_id
        join public.pulse_answers a on a.response_id = r.id
        join public.pulse_questions q on q.id = a.question_id
        where r.employee_number = e.employee_number
        group by c.period, r.answered_at
        order by c.period desc
        limit 6
      ) h
    ), '[]'::jsonb)
  from public.employees e
  where e.left_at is null
    and public.pulse_can_view_employee(e.employee_number)
  order by e.employee_number;
end;
$$;

revoke all on function public.pulse_list_member_summaries() from public, anon;
grant execute on function public.pulse_list_member_summaries() to authenticated, service_role;

-- ── pulse_person_history ──────────────────────────────────────────────
-- 1人の全サイクル回答履歴（古→新）。by_category は {カテゴリ: 平均} で
-- nps / 自由記述を除く。コメント（自由記述の回答本文ではなく response.comment）
-- も返す＝個人詳細のコメント履歴。
create or replace function public.pulse_person_history(p_employee_number text)
returns table (
  period text,
  cycle_id uuid,
  overall numeric,
  by_category jsonb,
  comment text,
  answered_at timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  if not (
    public.pulse_can_view_realname()
    and public.pulse_can_view_employee(p_employee_number)
  ) then
    raise exception 'pulse_person_history: permission denied';
  end if;

  return query
  select
    c.period,
    c.id,
    round(avg(a.score::numeric) filter (
      where a.score is not null and q.type in ('weather5','scale')), 3),
    coalesce((
      select jsonb_object_agg(bc.cat, bc.avg_s)
      from (
        select q2.category as cat, round(avg(a2.score::numeric), 3) as avg_s
        from public.pulse_answers a2
        join public.pulse_questions q2 on q2.id = a2.question_id
        where a2.response_id = r.id
          and a2.score is not null
          and q2.type in ('weather5','scale')
          and q2.category is not null and btrim(q2.category) <> ''
        group by q2.category
      ) bc
    ), '{}'::jsonb),
    r.comment,
    r.answered_at
  from public.pulse_responses r
  join public.pulse_cycles c on c.id = r.cycle_id
  join public.pulse_answers a on a.response_id = r.id
  join public.pulse_questions q on q.id = a.question_id
  where r.employee_number = p_employee_number
  group by c.period, c.id, r.id, r.comment, r.answered_at
  order by c.period asc;
end;
$$;

revoke all on function public.pulse_person_history(text) from public, anon;
grant execute on function public.pulse_person_history(text) to authenticated, service_role;

commit;
