-- ─────────────────────────────────────────────────────────────────────
-- 0023_pulse_aggregate_enrich
--
-- #4 パルスサーベイ スライス3（管理ダッシュボード）用に pulse_compute_aggregates
-- を差し替え、metrics jsonb を拡充する。
--   • 全 dimension 行（total/department/employment_type/position_title）:
--       {n, masked, avg_overall}  ← n<5 は avg をマスク
--   • total 行のみ追加:
--       {target, response_rate, weather_dist:{"1".."5"}, by_category:{cat:{avg,n}}}
--       target = 在籍社員数（left_at is null）、response_rate = n/target
--
-- 0021 の pulse_compute_aggregates を create or replace で置換（シグネチャ不変）。
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

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

  -- ── 全 dimension 行（base metrics: n / masked / avg_overall） ──
  with resp as (
    select r.id as response_id,
           r.snap_department as department,
           r.snap_employment_type as employment_type,
           r.snap_position_title as position_title,
           avg(a.score::numeric) filter (where a.score is not null) as overall
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    where r.cycle_id = v_cycle_id
    group by r.id, r.snap_department, r.snap_employment_type, r.snap_position_title
  ),
  dims as (
    select 'total'::text as dimension, ''::text as dimension_key, response_id, overall from resp
    union all
    select 'department', coalesce(nullif(btrim(department), ''), '(未設定)'), response_id, overall from resp
    union all
    select 'employment_type', coalesce(nullif(btrim(employment_type), ''), '(未設定)'), response_id, overall from resp
    union all
    select 'position_title', coalesce(nullif(btrim(position_title), ''), '(未設定)'), response_id, overall from resp
  ),
  agg as (
    select dimension, dimension_key, count(*) as n, round(avg(overall), 3) as avg_overall
    from dims group by dimension, dimension_key
  )
  insert into public.pulse_monthly_aggregates (period, dimension, dimension_key, metrics)
  select p_period, dimension, dimension_key,
    case when n < 5
      then jsonb_build_object('n', n, 'masked', true)
      else jsonb_build_object('n', n, 'masked', false, 'avg_overall', avg_overall)
    end
  from agg;

  get diagnostics v_rows = row_count;

  -- ── total 行に headline metrics を追記 ──
  select count(*) into v_target from public.employees where left_at is null;

  select count(distinct r.id) into v_total_n
  from public.pulse_responses r where r.cycle_id = v_cycle_id;

  -- 天気分布（answer-level score 1..5 の件数）
  select coalesce(jsonb_object_agg(score::text, c), '{}'::jsonb) into v_weather
  from (
    select a.score, count(*) as c
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    where r.cycle_id = v_cycle_id and a.score is not null
    group by a.score
  ) w;

  -- カテゴリ別平均（q.category ごと）
  select coalesce(jsonb_object_agg(cat, jsonb_build_object('avg', avg_s, 'n', n)), '{}'::jsonb) into v_by_cat
  from (
    select q.category as cat, round(avg(a.score::numeric), 3) as avg_s, count(*) as n
    from public.pulse_responses r
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.cycle_id = v_cycle_id
      and a.score is not null
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

commit;
