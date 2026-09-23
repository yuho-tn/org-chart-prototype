-- ─────────────────────────────────────────────────────────────────────
-- 0045_pulse_hardening
--
-- パルスサーベイ v2（設計書 PULSE_V2_DESIGN.md §2）— 既知バグ修正＋
-- プライバシー穴の封鎖＋管理ダッシュボード用 RPC 追加。
--
--   1. [重大修正] pulse_compute_aggregates 差し替え（0030版がベース）:
--        total 行で n<5 のとき weather_dist・by_category も付与しない
--        （既存の avg_overall マスク・enps_n<5 マスクは維持）。
--   2. [中] RLS 修正: pulse_monthly_aggregates・pulse_summaries の SELECT
--        ポリシーへ「pulse_scope() <> 'self'」条件を追加（admin は
--        pulse_scope()='all' なので無影響。scope=self の利用者は全社集計・
--        AI要約を見られなくする）。
--   3. [中] pulse_list_comments 差し替え: コメント個々について「同一
--        snap_department の scope内回答者数 < 5」なら department を null
--        で返す（コメント本文は返す。既存の全社 n<5 ブランケット非表示・
--        実名ゲートは維持）。
--   4. [中] pulse_evaluate_alerts 差し替え: on conflict ... do update set
--        reason = excluded.reason（re-evaluate 時に reason を最新化）。
--        pulse_alert_rules.type='custom' は本 RPC の判定ループ（absolute/
--        delta のみ処理）でスキップされる仕様は 0021 から変更なし。
--   5. 新RPC pulse_my_history() — ログイン本人の回答履歴（#/survey 送信後
--        の「マイパルス」用）。本人特定不可なら null、対象なら [] 以上。
--   6. 新RPC pulse_admin_cycle_stats() — 管理ダッシュボードのヒーローバー
--        用サイクル別 回答数/対象数。admin/can_manage_alert 限定。
--
-- 0021〜0031 で作られた権限モデル（SECURITY DEFINER・search_path固定・
-- authenticated へ grant・anon revoke）を破壊しない。
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 1. pulse_compute_aggregates（total 行の n<5 マスクを weather_dist/
--        by_category にも適用） ═══════════════════════════════════════
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
  v_scored_n integer;
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

  -- スコア回答（weather5/scale）を1問以上持つ回答者数。
  -- weather_dist / by_category のマスク判定はこの母数で行う
  -- （コメントのみの回答が v_total_n を押し上げて、少人数のスコア分布が
  --   n>=5 と誤判定されて露出するのを防ぐ）。
  select count(distinct r.id) into v_scored_n
  from public.pulse_responses r
  join public.pulse_answers a on a.response_id = r.id
  join public.pulse_questions q on q.id = a.question_id
  where r.cycle_id = v_cycle_id
    and a.score is not null
    and q.type in ('weather5','scale');

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

  -- [重大修正] スコア回答者が5人未満なら weather_dist・by_category は
  -- 付与しない（少人数の分布・カテゴリ内訳からの再識別を防止）。
  -- target・response_rate は運用上の必須値なので常に付与する。
  if v_scored_n >= 5 then
    update public.pulse_monthly_aggregates
    set metrics = metrics || jsonb_build_object(
          'target', v_target,
          'response_rate', case when coalesce(v_target,0) > 0
            then round(v_total_n::numeric / v_target, 3) else null end,
          'weather_dist', v_weather,
          'by_category', v_by_cat
        )
    where period = p_period and dimension = 'total';
  else
    update public.pulse_monthly_aggregates
    set metrics = metrics || jsonb_build_object(
          'target', v_target,
          'response_rate', case when coalesce(v_target,0) > 0
            then round(v_total_n::numeric / v_target, 3) else null end
        )
    where period = p_period and dimension = 'total';
  end if;

  return v_rows;
end;
$$;

-- ══ 2. RLS: pulse_monthly_aggregates / pulse_summaries に scope<>'self'
--        条件を追加（admin は pulse_scope()='all' なので無影響） ══════
drop policy if exists "pulse_monthly_aggregates read (access holders)" on public.pulse_monthly_aggregates;
create policy "pulse_monthly_aggregates read (access holders)"
  on public.pulse_monthly_aggregates for select to authenticated
  using (
    public.pulse_is_admin()
    or (
      exists (
        select 1 from public.pulse_access
        where email = lower(coalesce(auth.email(), ''))
      )
      and public.pulse_scope() <> 'self'
    )
  );

drop policy if exists "pulse_summaries read (access holders)" on public.pulse_summaries;
create policy "pulse_summaries read (access holders)"
  on public.pulse_summaries for select to authenticated
  using (
    public.pulse_is_admin()
    or (
      exists (
        select 1 from public.pulse_access
        where email = lower(coalesce(auth.email(), ''))
      )
      and public.pulse_scope() <> 'self'
    )
  );

-- ══ 3. pulse_list_comments（コメント単位の n<5 部署マスクを追加） ════
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
  with scoped as (
    select
      r.id as response_id,
      coalesce(nullif(btrim(r.snap_department), ''), e.department) as dept,
      r.comment,
      r.answered_at,
      case when v_realname
        then coalesce(e.display_name, e.full_name, r.employee_number)
        else null end as author_name
    from public.pulse_responses r
    join public.employees e on e.employee_number = r.employee_number
    where r.cycle_id = p_cycle_id
      and r.comment is not null
      and btrim(r.comment) <> ''
      and public.pulse_can_view_employee(r.employee_number)
  ),
  -- 部署ごとの n<5 判定は「scope内のコメント投稿者数」ではなく「scope内の
  -- 回答者数」で行う（commenters ⊆ respondents のため、コメント数だけで
  -- 数えると常に本来より厳しく判定され、実運用では部署がほぼ恒久的に
  -- マスクされてしまう）。scoped とは別に pulse_responses 全体を数える。
  dept_counts as (
    select
      coalesce(nullif(btrim(r.snap_department), ''), e.department) as dept,
      count(*) as n
    from public.pulse_responses r
    join public.employees e on e.employee_number = r.employee_number
    where r.cycle_id = p_cycle_id
      and public.pulse_can_view_employee(r.employee_number)
    group by 1
  )
  select
    s.response_id,
    s.author_name,
    -- 同一 snap_department の scope 内回答者数（コメント有無を問わない）が
    -- < 5 なら department を伏せる（本文は返す＝コメント自体はそのまま、
    -- 部署情報だけ再識別を防ぐ）。
    case when dc.n >= 5 then s.dept else null end,
    s.comment,
    s.answered_at
  from scoped s
  join dept_counts dc on dc.dept is not distinct from s.dept
  order by s.answered_at desc nulls last;
end;
$$;

revoke all on function public.pulse_list_comments(uuid) from public, anon;
grant execute on function public.pulse_list_comments(uuid) to authenticated, service_role;

-- ══ 4. pulse_evaluate_alerts（re-evaluate 時に reason を最新化） ═════
-- pulse_alert_rules.type='custom' は下記ループが absolute/delta のみを
-- 処理するため引き続きスキップされる（0021 からの既定挙動・変更なし）。
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
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason;
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
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason;
      get diagnostics v_delta = row_count;
      v_count := v_count + v_delta;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ══ 5. 新RPC: pulse_my_history（本人の回答履歴・「マイパルス」用） ══
-- 対象＝status in ('sent','closed') のサイクルで本人回答が存在するもの。
-- 本人特定不可（対象社員でない）なら null、対象だが履歴なしなら []。
create or replace function public.pulse_my_history()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_emp text := public.pulse_current_employee_number();
  v_result jsonb;
begin
  if v_emp is null then
    return null;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'period', h.period,
      'overall', h.overall,
      'by_category', h.by_category,
      'nps', h.nps,
      'submitted_at', h.answered_at
    ) order by h.period asc
  ), '[]'::jsonb)
  into v_result
  from (
    select
      c.period,
      round(avg(a.score::numeric) filter (
        where a.score is not null and q.type in ('weather5','scale')), 3) as overall,
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
      ), '{}'::jsonb) as by_category,
      round(avg(a.score::numeric) filter (
        where a.score is not null and q.type = 'nps'), 1) as nps,
      r.answered_at
    from public.pulse_responses r
    join public.pulse_cycles c on c.id = r.cycle_id
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.employee_number = v_emp
      and c.status in ('sent','closed')
    group by c.period, r.id, r.answered_at
  ) h;

  return v_result;
end;
$$;

revoke all on function public.pulse_my_history() from public, anon;
grant execute on function public.pulse_my_history() to authenticated, service_role;

-- ══ 6. 新RPC: pulse_admin_cycle_stats（ヒーローバーの回答数/対象数） ══
-- target = 在籍者数（employees.left_at is null・現在時点のスナップ）。
-- ゲート: admin or can_manage_alert。それ以外は insufficient_privilege。
create or replace function public.pulse_admin_cycle_stats()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_target integer;
  v_result jsonb;
begin
  if not (public.pulse_is_admin() or public.pulse_can_manage_alert()) then
    raise exception 'pulse_admin_cycle_stats: insufficient_privilege'
      using errcode = '42501';
  end if;

  select count(*) into v_target from public.employees where left_at is null;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'cycle_id', c.id,
      'responses', coalesce(rc.n, 0),
      'target', v_target
    ) order by c.period desc
  ), '[]'::jsonb)
  into v_result
  from public.pulse_cycles c
  left join (
    select cycle_id, count(*) as n
    from public.pulse_responses
    group by cycle_id
  ) rc on rc.cycle_id = c.id;

  return v_result;
end;
$$;

revoke all on function public.pulse_admin_cycle_stats() from public, anon;
grant execute on function public.pulse_admin_cycle_stats() to authenticated, service_role;

commit;
