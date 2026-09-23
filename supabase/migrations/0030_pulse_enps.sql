-- ─────────────────────────────────────────────────────────────────────
-- 0030_pulse_enps
--
-- P4-②（eNPS 設問型）。
--   1. pulse_questions.type に 'nps'（0〜10 の11段階）を追加
--   2. pulse_answers.score の check を 0..10 に拡張（型別の厳密検証は
--      pulse_submit_response 側で実施）
--   3. pulse_submit_response を差し替え — 設問型ごとの score 検証を追加
--        weather5 / scale → 1..5、nps → 0..10、free_text → score 不可
--   4. pulse_compute_aggregates を差し替え（0023 を置換）—
--        overall / weather_dist / by_category から nps を除外し、
--        eNPS（推奨者9-10% − 批判者0-6%）を全 dimension で算出。
--        eNPS も n<5 マスク準拠（enps_n < 5 は enps_masked=true・値なし）。
--   5. pulse_evaluate_alerts を差し替え — overall から nps を除外
--        （0..10 スコアがアラート閾値を汚染しないように）
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ── 1. 設問型 'nps' を追加 ────────────────────────────────────────────
alter table public.pulse_questions
  drop constraint if exists pulse_questions_type_check;
alter table public.pulse_questions
  add constraint pulse_questions_type_check
  check (type in ('weather5','scale','free_text','nps'));

-- ── 2. score の器を 0..10 に拡張 ─────────────────────────────────────
alter table public.pulse_answers
  drop constraint if exists pulse_answers_score_check;
alter table public.pulse_answers
  add constraint pulse_answers_score_check
  check (score between 0 and 10);

-- ── 3. pulse_submit_response（型別 score 検証を追加） ────────────────
create or replace function public.pulse_submit_response(
  p_cycle_id uuid,
  p_answers jsonb,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp text := public.pulse_current_employee_number();
  v_status text;
  v_qset uuid;
  v_dept text;
  v_emp_type text;
  v_pos text;
  v_response_id uuid;
  v_ans jsonb;
  v_qid text;
  v_qtype text;
  v_score integer;
begin
  if v_emp is null then
    raise exception 'pulse_submit_response: caller is not a registered in-service employee';
  end if;

  select status, question_set_id into v_status, v_qset
  from public.pulse_cycles where id = p_cycle_id;
  if not found then
    raise exception 'pulse_submit_response: cycle % not found', p_cycle_id;
  end if;
  if v_status <> 'sent' then
    raise exception 'pulse_submit_response: cycle is not open for responses (status=%)', v_status;
  end if;

  select department, employment_type, position_title
    into v_dept, v_emp_type, v_pos
  from public.employees where employee_number = v_emp;

  insert into public.pulse_responses
    (cycle_id, employee_number, source, answered_at, comment,
     snap_department, snap_employment_type, snap_position_title)
  values
    (p_cycle_id, v_emp, 'native', now(), p_comment, v_dept, v_emp_type, v_pos)
  on conflict (cycle_id, employee_number) do update
    set answered_at = now(),
        comment = excluded.comment,
        snap_department = excluded.snap_department,
        snap_employment_type = excluded.snap_employment_type,
        snap_position_title = excluded.snap_position_title,
        updated_at = now()
  returning id into v_response_id;

  -- answers を総入れ替え（部分更新の齟齬を避ける）
  delete from public.pulse_answers where response_id = v_response_id;

  for v_ans in
    select value from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb))
  loop
    v_qid := v_ans->>'question_id';
    if v_qid is null then
      continue;
    end if;
    -- 設問が当サイクルの設問セットに属し active であることを検証（型も取得）
    select q.type into v_qtype
    from public.pulse_questions q
    where q.id = v_qid::uuid
      and q.question_set_id = v_qset
      and q.is_active;
    if not found then
      raise exception 'pulse_submit_response: question % is not in the active set for this cycle', v_qid;
    end if;

    v_score := nullif(v_ans->>'score', '')::integer;

    -- 設問型ごとの score 検証（器の check 0..10 より厳密に）
    if v_qtype in ('weather5','scale') and v_score is not null
      and (v_score < 1 or v_score > 5) then
      raise exception 'pulse_submit_response: score % out of range 1..5 for % question %', v_score, v_qtype, v_qid;
    end if;
    if v_qtype = 'nps' and v_score is not null
      and (v_score < 0 or v_score > 10) then
      raise exception 'pulse_submit_response: score % out of range 0..10 for nps question %', v_score, v_qid;
    end if;
    if v_qtype = 'free_text' and v_score is not null then
      raise exception 'pulse_submit_response: free_text question % cannot take a score', v_qid;
    end if;

    insert into public.pulse_answers (response_id, question_id, score, value_text)
    values (
      v_response_id,
      v_qid::uuid,
      v_score,
      nullif(v_ans->>'value_text', '')
    );
  end loop;

  return v_response_id;
end;
$$;

-- ── 4. pulse_compute_aggregates（nps 除外＋eNPS 算出） ───────────────
create or replace function public.pulse_compute_aggregates(p_period text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_rows integer := 0;
  v_target integer;
  v_total_n integer;
  v_weather jsonb;
  v_by_cat jsonb;
begin
  if not (public.pulse_is_admin() or public.pulse_can_manage_alert()) then
    raise exception 'pulse_compute_aggregates: permission denied';
  end if;

  select id into v_cycle_id from public.pulse_cycles where period = p_period;
  if not found then
    raise exception 'pulse_compute_aggregates: no cycle for period %', p_period;
  end if;

  delete from public.pulse_monthly_aggregates where period = p_period;

  -- ── 全 dimension 行（n / masked / avg_overall ＋ eNPS） ──
  -- overall は weather5・scale のみ（nps の 0..10 を混ぜない）。
  -- nps_score は 1回答 = 1票（複数 nps 設問がある場合は回答内平均）。
  with resp as (
    select r.id as response_id,
           r.snap_department as department,
           r.snap_employment_type as employment_type,
           r.snap_position_title as position_title,
           avg(a.score::numeric) filter (
             where a.score is not null and q.type in ('weather5','scale')) as overall,
           avg(a.score::numeric) filter (
             where a.score is not null and q.type = 'nps') as nps_score
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.cycle_id = v_cycle_id
    group by r.id, r.snap_department, r.snap_employment_type, r.snap_position_title
  ),
  dims as (
    select 'total'::text as dimension, ''::text as dimension_key, response_id, overall, nps_score from resp
    union all
    select 'department', coalesce(nullif(btrim(department), ''), '(未設定)'), response_id, overall, nps_score from resp
    union all
    select 'employment_type', coalesce(nullif(btrim(employment_type), ''), '(未設定)'), response_id, overall, nps_score from resp
    union all
    select 'position_title', coalesce(nullif(btrim(position_title), ''), '(未設定)'), response_id, overall, nps_score from resp
  ),
  agg as (
    select dimension, dimension_key,
           count(*) as n,
           round(avg(overall), 3) as avg_overall,
           count(*) filter (where nps_score is not null) as enps_n,
           count(*) filter (where nps_score >= 9) as promoters,
           count(*) filter (where nps_score <= 6) as detractors
    from dims
    group by dimension, dimension_key
  )
  insert into public.pulse_monthly_aggregates (period, dimension, dimension_key, metrics)
  select p_period, dimension, dimension_key,
    (case when n < 5
      then jsonb_build_object('n', n, 'masked', true)
      else jsonb_build_object('n', n, 'masked', false, 'avg_overall', avg_overall)
    end)
    ||
    (case
      when enps_n = 0 then '{}'::jsonb
      when enps_n < 5 then jsonb_build_object('enps_n', enps_n, 'enps_masked', true)
      else jsonb_build_object(
        'enps_n', enps_n,
        'enps_masked', false,
        'enps', round(100.0 * promoters / enps_n - 100.0 * detractors / enps_n, 1),
        'promoter_rate', round(100.0 * promoters / enps_n, 1),
        'detractor_rate', round(100.0 * detractors / enps_n, 1))
    end)
  from agg;

  get diagnostics v_rows = row_count;

  -- ── total 行に headline metrics を追記 ──
  select count(*) into v_target from public.employees where left_at is null;

  select count(distinct r.id) into v_total_n
  from public.pulse_responses r where r.cycle_id = v_cycle_id;

  -- 天気分布（weather5 設問の score 1..5 の件数のみ）
  select coalesce(jsonb_object_agg(score::text, c), '{}'::jsonb) into v_weather
  from (
    select a.score, count(*) as c
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.cycle_id = v_cycle_id
      and a.score is not null
      and q.type = 'weather5'
    group by a.score
  ) w;

  -- カテゴリ別平均（weather5・scale のみ・q.category ごと）
  select coalesce(jsonb_object_agg(cat, jsonb_build_object('avg', avg_s, 'n', n)), '{}'::jsonb) into v_by_cat
  from (
    select q.category as cat, round(avg(a.score::numeric), 3) as avg_s, count(*) as n
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.cycle_id = v_cycle_id
      and a.score is not null
      and q.type in ('weather5','scale')
      and q.category is not null and btrim(q.category) <> ''
    group by q.category
  ) c;

  update public.pulse_monthly_aggregates
  set metrics = metrics || jsonb_build_object(
        'target', v_target,
        'response_rate', case when coalesce(v_target,0) > 0
          then round(v_total_n::numeric / v_target, 3) else null end,
        'weather_dist', v_weather,
        'by_category', v_by_cat
      )
  where period = p_period and dimension = 'total';

  return v_rows;
end;
$$;

-- ── 5. pulse_evaluate_alerts（overall から nps を除外） ──────────────
create or replace function public.pulse_evaluate_alerts(p_cycle_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text;
  v_prev_cycle uuid;
  v_count integer := 0;
  v_delta integer;
  v_rule record;
  v_threshold numeric;
  v_drop numeric;
begin
  if not (public.pulse_is_admin() or public.pulse_can_manage_alert()) then
    raise exception 'pulse_evaluate_alerts: permission denied';
  end if;

  select period into v_period from public.pulse_cycles where id = p_cycle_id;
  if not found then
    raise exception 'pulse_evaluate_alerts: cycle % not found', p_cycle_id;
  end if;

  select id into v_prev_cycle
  from public.pulse_cycles
  where period < v_period
  order by period desc
  limit 1;

  for v_rule in
    select * from public.pulse_alert_rules where is_active
  loop
    if v_rule.type = 'absolute' then
      v_threshold := coalesce(nullif(v_rule.params->>'threshold', '')::numeric, 2);
      insert into public.pulse_alerts (employee_number, cycle_id, type, reason, status)
      select cur.employee_number, p_cycle_id, 'absolute',
             jsonb_build_object(
               'rule_id', v_rule.id, 'rule', v_rule.name,
               'overall', round(cur.overall, 3), 'threshold', v_threshold),
             'open'
      from (
        select r.employee_number,
               avg(a.score::numeric) filter (
                 where a.score is not null and q.type in ('weather5','scale')) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
        join public.pulse_questions q on q.id = a.question_id
        where r.cycle_id = p_cycle_id
        group by r.employee_number
      ) cur
      where cur.overall is not null
        and cur.overall <= v_threshold
      on conflict (employee_number, cycle_id, type) do nothing;
      get diagnostics v_delta = row_count;
      v_count := v_count + v_delta;

    elsif v_rule.type = 'delta' and v_prev_cycle is not null then
      v_drop := coalesce(nullif(v_rule.params->>'drop', '')::numeric, 1.5);
      insert into public.pulse_alerts (employee_number, cycle_id, type, reason, status)
      select cur.employee_number, p_cycle_id, 'delta',
             jsonb_build_object(
               'rule_id', v_rule.id, 'rule', v_rule.name,
               'overall', round(cur.overall, 3), 'prev_overall', round(prev.overall, 3),
               'delta', round(cur.overall - prev.overall, 3), 'drop_threshold', v_drop),
             'open'
      from (
        select r.employee_number,
               avg(a.score::numeric) filter (
                 where a.score is not null and q.type in ('weather5','scale')) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
        join public.pulse_questions q on q.id = a.question_id
        where r.cycle_id = p_cycle_id
        group by r.employee_number
      ) cur
      join (
        select r.employee_number,
               avg(a.score::numeric) filter (
                 where a.score is not null and q.type in ('weather5','scale')) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
        join public.pulse_questions q on q.id = a.question_id
        where r.cycle_id = v_prev_cycle
        group by r.employee_number
      ) prev on prev.employee_number = cur.employee_number
      where cur.overall is not null
        and prev.overall is not null
        and (prev.overall - cur.overall) >= v_drop
      on conflict (employee_number, cycle_id, type) do nothing;
      get diagnostics v_delta = row_count;
      v_count := v_count + v_delta;
    end if;
  end loop;

  return v_count;
end;
$$;

commit;
