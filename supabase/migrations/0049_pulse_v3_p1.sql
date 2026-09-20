-- ─────────────────────────────────────────────────────────────────────
-- 0049_pulse_v3_p1
--
-- パルスサーベイ v3 P0（活性化準備）+ P1（回答摩擦ゼロ）のバックエンド一式。
-- 設計書: docs/PULSE_V3_DESIGN.md §3（この migration は §3-1〜§3-10 に対応）。
-- 上位の決定: memory project_talenthub_pulse_v3（2026-09-20 裕鵬さん裁定 決定1〜9）。
--
-- 内容:
--   1. pulse_settings          — シングルトン運用設定（閲覧者告知文・対象雇用形態・
--                                 配信テンプレ・リマインド間隔/上限）
--   2. pulse_target_exclusions — 対象者の個別除外（決定3）
--   3. 対象者判定・営業日ヘルパー — pulse_is_target / pulse_target_count /
--                                 pulse_target_employee_numbers / pulse_holidays /
--                                 pulse_is_business_day / pulse_business_days_after
--   4. pulse_compute_aggregates / pulse_admin_cycle_stats の分母を
--      「在籍者全員」から「対象者（pulse_target_count）」に差し替え（0045版を
--      丸ごとコピーし該当1行のみ置換。それ以外は無改変）
--   5. 回答 bundle RPC — 内部 pulse__survey_bundle（トークン経路／ログイン経路
--      共通の JSON 形）＋ 公開 pulse_my_survey（authenticated）／
--      pulse_survey_bundle_for（service_role 専用・Edge pulse-answer 用）
--   6. 回答保存 RPC の共通化 — 内部 pulse__submit_response ＋ 公開
--      pulse_submit_response（既存シグネチャ維持）／pulse_submit_response_for
--      （service_role 専用）。pulse_is_target 検証・2000字上限を追加
--   7. pulse_my_history() 拡張 — cycle_id・sum_score・comment を追加（既存キー維持）
--   8. pulse_notifications に reminder_no 列 ＋ 複合 index
--   9. RLS 締め — pulse_question_sets / pulse_questions / pulse_cycles の
--      SELECT を「pulse_is_admin() or pulse_scope() <> 'self'」に変更
--      （回答者は直読せず §5 RPC 経由に切替。0045 の pulse_monthly_aggregates
--      と同じ述語＝pulse_scope() は pulse_access 未登録者に対し既定で 'self' を
--      返すため、この述語だけで「access holder かつ scope<>self」と等価）
--
-- 命名規約: pulse__ 始まり（二重アンダースコア）＝内部専用関数。public/anon は
-- もちろん authenticated からも revoke し、呼び出しは同一トランザクション内の
-- 別の SECURITY DEFINER 関数（=同じ所有者ロールとして実行される）経由のみに限定する。
--
-- 流儀は 0021〜0045 と同一（SECURITY DEFINER・set search_path = public・
-- revoke all ... from public, anon・必要ロールにのみ grant execute・冪等）。
-- 1トランザクション。Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 3-1. pulse_settings（シングルトン・運用設定） ════════════════════
create table if not exists public.pulse_settings (
  id smallint primary key default 1 check (id = 1),
  viewer_notice text not null default 'あなたの回答は、人事担当（高谷・丹野）が閲覧します。回答内容は本人の許可なく他の人に共有されることはありません。',
  manager_disclosure_enabled boolean not null default false,
  target_employment_types text[] not null default '{正社員,限定正社員}',
  notify_broadcast_template text not null default '{name}さん、{month}分のパルスサーベイの回答をお願いします（所要{minutes}分）
{url}
締切：{due}まで。このURLはあなた専用です（転送しないでください）。',
  notify_reminder_template text not null default '{name}さん、{month}分のパルスサーベイがまだ回答されていません（所要{minutes}分）
{url}
締切：{due}まで。',
  notify_email_subject_template text not null default '【TalentHub】{month}分パルスサーベイのご回答のお願い',
  reminder_interval_business_days smallint not null default 2
    check (reminder_interval_business_days between 1 and 10),
  reminder_max_count smallint not null default 4
    check (reminder_max_count between 0 and 10),
  survey_minutes smallint not null default 1,
  updated_at timestamptz not null default now(),
  updated_by_email text
);

insert into public.pulse_settings (id) values (1) on conflict do nothing;

-- 0021 の touch_updated_at() は updated_at のみを更新し updated_by_email は
-- フロントが明示的に渡す流儀（pulse_access 等）。pulse_settings は現時点で
-- 専用の編集画面を持たない（SQL Editor 直接操作＝§4 運用）ため、同型の
-- 既存トリガは無い。updated_by_email を自動補完する専用トリガを新設する。
create or replace function public.pulse_settings_touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  new.updated_by_email := lower(coalesce(auth.email(), new.updated_by_email));
  return new;
end;
$$;

drop trigger if exists pulse_settings_touch_updated_at on public.pulse_settings;
create trigger pulse_settings_touch_updated_at
  before update on public.pulse_settings
  for each row execute function public.pulse_settings_touch_updated_at();

alter table public.pulse_settings enable row level security;

drop policy if exists "pulse_settings read (admin or access holder)" on public.pulse_settings;
create policy "pulse_settings read (admin or access holder)"
  on public.pulse_settings for select to authenticated
  using (public.pulse_is_admin() or public.pulse_scope() <> 'self');

drop policy if exists "pulse_settings write (admin)" on public.pulse_settings;
create policy "pulse_settings write (admin)"
  on public.pulse_settings for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

revoke all on public.pulse_settings from anon;
-- 既定ACL（pg_default_acl）由来の delete/truncate 等を authenticated に残さない（0021 流儀）。
-- シングルトン行が消えると pulse_is_target が全員対象外になるため delete は誰にも渡さない。
revoke all on public.pulse_settings from authenticated;
grant select, insert, update on public.pulse_settings to authenticated;

-- ══ 3-2. pulse_target_exclusions（対象者の個別除外・決定3） ══════════
create table if not exists public.pulse_target_exclusions (
  employee_number text primary key references public.employees(employee_number) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  created_by_email text
);

alter table public.pulse_target_exclusions enable row level security;

drop policy if exists "pulse_target_exclusions read (admin)" on public.pulse_target_exclusions;
create policy "pulse_target_exclusions read (admin)"
  on public.pulse_target_exclusions for select to authenticated
  using (public.pulse_is_admin());

drop policy if exists "pulse_target_exclusions write (admin)" on public.pulse_target_exclusions;
create policy "pulse_target_exclusions write (admin)"
  on public.pulse_target_exclusions for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

revoke all on public.pulse_target_exclusions from anon;
grant select, insert, update, delete on public.pulse_target_exclusions to authenticated;

-- ══ 3-3a. 対象者判定ヘルパー ══════════════════════════════════════════
-- 対象＝在籍（left_at is null）かつ employment_type が settings の
-- target_employment_types に含まれる かつ 個別除外に無い。
create or replace function public.pulse_is_target(p_emp text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.employees e
    cross join public.pulse_settings s
    where e.employee_number = p_emp
      and e.left_at is null
      and e.employment_type = any (s.target_employment_types)
      and not exists (
        select 1 from public.pulse_target_exclusions x
        where x.employee_number = e.employee_number
      )
  )
$$;

create or replace function public.pulse_target_count()
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select count(*)::integer
  from public.employees e
  cross join public.pulse_settings s
  where e.left_at is null
    and e.employment_type = any (s.target_employment_types)
    and not exists (
      select 1 from public.pulse_target_exclusions x
      where x.employee_number = e.employee_number
    )
$$;

-- Edge (pulse-notify) 用: 対象者の employee_number を一括取得。
create or replace function public.pulse_target_employee_numbers()
returns setof text
language sql
security definer
set search_path = public
stable
as $$
  select e.employee_number
  from public.employees e
  cross join public.pulse_settings s
  where e.left_at is null
    and e.employment_type = any (s.target_employment_types)
    and not exists (
      select 1 from public.pulse_target_exclusions x
      where x.employee_number = e.employee_number
    )
$$;

-- 呼び出し元は SECURITY DEFINER の内部関数（owner 権限で実行）と Edge（service_role）のみ。
-- authenticated へは渡さない（employees の差分から admin 専用の除外リストが推定できるため）。
revoke all on function public.pulse_is_target(text) from public, anon, authenticated;
revoke all on function public.pulse_target_count() from public, anon, authenticated;
revoke all on function public.pulse_target_employee_numbers() from public, anon, authenticated;
grant execute on function public.pulse_is_target(text) to service_role;
grant execute on function public.pulse_target_count() to service_role;
grant execute on function public.pulse_target_employee_numbers() to service_role;

-- ══ 3-3b. 祝日テーブル＋営業日ヘルパー ════════════════════════════════
create table if not exists public.pulse_holidays (
  holiday_date date primary key,
  name text not null,
  kind text not null default 'national'
    check (kind in ('national','substitute'))
);

alter table public.pulse_holidays enable row level security;

drop policy if exists "pulse_holidays read (authenticated)" on public.pulse_holidays;
create policy "pulse_holidays read (authenticated)"
  on public.pulse_holidays for select to authenticated using (true);

drop policy if exists "pulse_holidays write (admin)" on public.pulse_holidays;
create policy "pulse_holidays write (admin)"
  on public.pulse_holidays for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

revoke all on public.pulse_holidays from anon;
grant select, insert, update, delete on public.pulse_holidays to authenticated;

-- seed: 2026-10-01〜2027-12-31 の国民の祝日・振替休日。
-- 固定日・ハッピーマンデー（成人/海/敬老/スポーツの日）は法定計算のため確度が高い。
-- ⚠ 2027-03-21（春分の日）・2027-09-23（秋分の日）は天文計算による推定値
--   （国立天文台が例年2月頃の官報「暦要項」で確定するまでは非公式）。
--   ⚠ 内閣府公表値との照合要。ズレていた場合は該当行と振替休日行（春分側の
--   2027-03-22）を UPDATE/DELETE で訂正すること。
insert into public.pulse_holidays (holiday_date, name, kind) values
  ('2026-10-12', 'スポーツの日', 'national'),
  ('2026-11-03', '文化の日', 'national'),
  ('2026-11-23', '勤労感謝の日', 'national'),
  ('2027-01-01', '元日', 'national'),
  ('2027-01-11', '成人の日', 'national'),
  ('2027-02-11', '建国記念の日', 'national'),
  ('2027-02-23', '天皇誕生日', 'national'),
  ('2027-03-21', '春分の日', 'national'),
  ('2027-03-22', '振替休日', 'substitute'),
  ('2027-04-29', '昭和の日', 'national'),
  ('2027-05-03', '憲法記念日', 'national'),
  ('2027-05-04', 'みどりの日', 'national'),
  ('2027-05-05', 'こどもの日', 'national'),
  ('2027-07-19', '海の日', 'national'),
  ('2027-08-11', '山の日', 'national'),
  ('2027-09-20', '敬老の日', 'national'),
  ('2027-09-23', '秋分の日', 'national'),
  ('2027-10-11', 'スポーツの日', 'national'),
  ('2027-11-03', '文化の日', 'national'),
  ('2027-11-23', '勤労感謝の日', 'national')
on conflict (holiday_date) do nothing;

create or replace function public.pulse_is_business_day(d date)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select d is not null
    and extract(isodow from d) < 6
    and not exists (select 1 from public.pulse_holidays h where h.holiday_date = d)
$$;

-- 区間 (p_from, p_to] の営業日数（p_from 当日は数えない）。
-- p_from/p_to が null、または p_to <= p_from のときは 0（generate_series の
-- null/逆区間まかせにせず明示的に短絡する）。
create or replace function public.pulse_business_days_after(p_from date, p_to date)
returns integer
language sql
security definer
set search_path = public
stable
as $$
  select case
    when p_from is null or p_to is null or p_to <= p_from then 0
    else (
      select count(*)::integer
      from generate_series(p_from + 1, p_to, interval '1 day') as d(day)
      where public.pulse_is_business_day(d.day::date)
    )
  end
$$;

revoke all on function public.pulse_is_business_day(date) from public, anon;
revoke all on function public.pulse_business_days_after(date, date) from public, anon;
grant execute on function public.pulse_is_business_day(date) to authenticated, service_role;
grant execute on function public.pulse_business_days_after(date, date) to authenticated, service_role;

-- ══ 3-3c. pulse_compute_aggregates / pulse_admin_cycle_stats の分母を
--          対象者数（pulse_target_count）へ差し替え。関数本体は 0045 版を
--          丸ごとコピーし、対象行のみ置換（それ以外は一字一句無改変）。 ══
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
  select public.pulse_target_count() into v_target;

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

  select public.pulse_target_count() into v_target;

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

-- (既存 grant は 0021/0045 でこの2関数へ既に付与済み・シグネチャ不変のため再掲不要)

-- ══ 3-4. 回答 bundle（内部）＋ 公開 RPC 2本 ═══════════════════════════
-- 内部専用。public/anon/authenticated すべて revoke・service_role にも
-- grant しない（呼び出しは同一トランザクション内の SECURITY DEFINER 関数
-- 経由のみ＝実行時ロールは関数所有者になるため、所有者は自分自身が作った
-- この関数への EXECUTE 権を暗黙に持つ＝GRANT が無くても呼べる）。
create or replace function public.pulse__survey_bundle(p_emp text, p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_emp public.employees;
  v_is_target boolean;
  v_cycle public.pulse_cycles;
  v_questions jsonb;
  v_response public.pulse_responses;
  v_answers jsonb;
  v_settings public.pulse_settings;
  v_manager_disclosure boolean := false;
  v_manager_names jsonb := '[]'::jsonb;
  v_previous jsonb;
begin
  -- 社員が見つからない（在籍でない）なら null
  select * into v_emp from public.employees where employee_number = p_emp and left_at is null;
  if not found then
    return null;
  end if;

  v_is_target := public.pulse_is_target(p_emp);

  select * into v_cycle from public.pulse_cycles where id = p_cycle_id;
  if not found then
    return null;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', q.id,
      'sort_order', q.sort_order,
      'label', q.label,
      'category', q.category,
      'type', q.type
    ) order by q.sort_order
  ), '[]'::jsonb)
  into v_questions
  from public.pulse_questions q
  where q.question_set_id = v_cycle.question_set_id
    and q.is_active;

  select * into v_response
  from public.pulse_responses
  where cycle_id = p_cycle_id and employee_number = p_emp;

  if v_response.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'question_id', a.question_id,
             'score', a.score,
             'value_text', a.value_text)), '[]'::jsonb)
      into v_answers
    from public.pulse_answers a
    where a.response_id = v_response.id;
  else
    v_answers := '[]'::jsonb;
  end if;

  select * into v_settings from public.pulse_settings where id = 1;

  -- 閲覧者の明示（決定1）: manager_names は pulse_access(scope='own_unit') を
  -- 上長の実体として使う。一致条件は pulse_can_view_employee と同一
  -- （department が非null・非空・own_unit_departments に含まれる）。
  v_manager_disclosure := coalesce(v_settings.manager_disclosure_enabled, false);
  if v_manager_disclosure then
    select coalesce(jsonb_agg(distinct nm order by nm), '[]'::jsonb)
      into v_manager_names
    from (
      select coalesce(m.display_name, m.full_name, m.employee_number) as nm
      from public.pulse_access pa
      join public.employees m on lower(coalesce(m.email, '')) = pa.email
      where pa.scope = 'own_unit'
        and v_emp.department is not null
        and btrim(v_emp.department) <> ''
        and v_emp.department = any (coalesce(pa.own_unit_departments, array[]::text[]))
        and pa.email <> lower(coalesce(v_emp.email, ''))
    ) x;
  else
    v_manager_names := '[]'::jsonb;
  end if;

  -- previous: 本人の回答がある直近の過去サイクル（by_category は 0045
  -- pulse_my_history と同じ組み立て方）
  select jsonb_build_object(
      'period', h.period,
      'by_category', h.by_category,
      'nps', h.nps,
      'answered_at', h.answered_at
    )
    into v_previous
  from (
    select
      c.period,
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
    where r.employee_number = p_emp
      and c.period < v_cycle.period
      and c.status in ('sent','closed')
    group by c.period, r.id, r.answered_at
    order by c.period desc
    limit 1
  ) h;

  return jsonb_build_object(
    'employee_number', p_emp,
    'display_name', coalesce(v_emp.display_name, v_emp.full_name),
    'is_target', v_is_target,
    'cycle', jsonb_build_object(
      'id', v_cycle.id,
      'period', v_cycle.period,
      'send_date', v_cycle.send_date,
      'due_date', v_cycle.due_date,
      'status', v_cycle.status
    ),
    'questions', v_questions,
    'response', case when v_response.id is null then null else jsonb_build_object(
      'id', v_response.id,
      'answered_at', v_response.answered_at,
      'comment', v_response.comment,
      'updated_at', v_response.updated_at
    ) end,
    'answers', v_answers,
    'viewers', jsonb_build_object(
      'notice', coalesce(v_settings.viewer_notice, ''),
      'manager_disclosure', v_manager_disclosure,
      'manager_names', v_manager_names
    ),
    'previous', v_previous
  );
end;
$$;

revoke all on function public.pulse__survey_bundle(text, uuid) from public, anon, authenticated;

-- 公開1: ログイン経路（#/survey・セッションあり）。受付中サイクルが無ければ
-- {"cycle": null}。本人特定不可（対象社員のレコードが無い）なら null。
create or replace function public.pulse_my_survey()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_emp text := public.pulse_current_employee_number();
  v_cycle_id uuid;
begin
  if v_emp is null then
    return null;
  end if;

  select id into v_cycle_id
  from public.pulse_cycles
  where status = 'sent'
  order by period desc
  limit 1;

  if v_cycle_id is null then
    return jsonb_build_object('cycle', null);
  end if;

  return public.pulse__survey_bundle(v_emp, v_cycle_id);
end;
$$;

revoke all on function public.pulse_my_survey() from public, anon;
grant execute on function public.pulse_my_survey() to authenticated, service_role;

-- 公開2: トークン経路（Edge pulse-answer 専用）。service_role のみ。
create or replace function public.pulse_survey_bundle_for(p_emp text, p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
begin
  return public.pulse__survey_bundle(p_emp, p_cycle_id);
end;
$$;

revoke all on function public.pulse_survey_bundle_for(text, uuid) from public, anon, authenticated;
grant execute on function public.pulse_survey_bundle_for(text, uuid) to service_role;

-- ══ 3-6. 回答保存 RPC の共通化 ════════════════════════════════════════
-- 内部専用（0030 版 pulse_submit_response の本体をここへ移設＋検証追加：
-- pulse_is_target・comment/value_text 2000字上限）。
create or replace function public.pulse__submit_response(
  p_emp text,
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
  v_value_text text;
begin
  if p_emp is null then
    raise exception 'pulse__submit_response: employee_number is required';
  end if;

  if not public.pulse_is_target(p_emp) then
    raise exception 'not_target';
  end if;

  if p_comment is not null and length(p_comment) > 2000 then
    raise exception 'pulse__submit_response: comment exceeds 2000 characters';
  end if;

  select status, question_set_id into v_status, v_qset
  from public.pulse_cycles where id = p_cycle_id;
  if not found then
    raise exception 'pulse__submit_response: cycle % not found', p_cycle_id;
  end if;
  if v_status <> 'sent' then
    raise exception 'pulse__submit_response: cycle is not open for responses (status=%)', v_status;
  end if;

  select department, employment_type, position_title
    into v_dept, v_emp_type, v_pos
  from public.employees where employee_number = p_emp;

  insert into public.pulse_responses
    (cycle_id, employee_number, source, answered_at, comment,
     snap_department, snap_employment_type, snap_position_title)
  values
    (p_cycle_id, p_emp, 'native', now(), p_comment, v_dept, v_emp_type, v_pos)
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
      raise exception 'pulse__submit_response: question % is not in the active set for this cycle', v_qid;
    end if;

    v_score := nullif(v_ans->>'score', '')::integer;
    v_value_text := nullif(v_ans->>'value_text', '');

    -- 設問型ごとの score 検証（器の check 0..10 より厳密に）
    if v_qtype in ('weather5','scale') and v_score is not null
      and (v_score < 1 or v_score > 5) then
      raise exception 'pulse__submit_response: score % out of range 1..5 for % question %', v_score, v_qtype, v_qid;
    end if;
    if v_qtype = 'nps' and v_score is not null
      and (v_score < 0 or v_score > 10) then
      raise exception 'pulse__submit_response: score % out of range 0..10 for nps question %', v_score, v_qid;
    end if;
    if v_qtype = 'free_text' and v_score is not null then
      raise exception 'pulse__submit_response: free_text question % cannot take a score', v_qid;
    end if;
    if v_value_text is not null and length(v_value_text) > 2000 then
      raise exception 'pulse__submit_response: value_text exceeds 2000 characters for question %', v_qid;
    end if;

    insert into public.pulse_answers (response_id, question_id, score, value_text)
    values (v_response_id, v_qid::uuid, v_score, v_value_text);
  end loop;

  return v_response_id;
end;
$$;

revoke all on function public.pulse__submit_response(text, uuid, jsonb, text) from public, anon, authenticated;

-- 公開1: 既存シグネチャ維持（ログイン経路・既存フロント互換）。
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
begin
  if v_emp is null then
    raise exception 'pulse_submit_response: caller is not a registered in-service employee';
  end if;
  return public.pulse__submit_response(v_emp, p_cycle_id, p_answers, p_comment);
end;
$$;

-- (既存 grant は 0021 でこのシグネチャへ既に付与済み・不変のため再掲不要)

-- 公開2: トークン経路（Edge pulse-answer 専用）。service_role のみ。
create or replace function public.pulse_submit_response_for(
  p_emp text,
  p_cycle_id uuid,
  p_answers jsonb,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  return public.pulse__submit_response(p_emp, p_cycle_id, p_answers, p_comment);
end;
$$;

revoke all on function public.pulse_submit_response_for(text, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.pulse_submit_response_for(text, uuid, jsonb, text) to service_role;

-- ══ 3-7. pulse_my_history() 拡張（cycle_id・sum_score・comment を追加。
--          0045 版がベース・既存キーは維持） ═══════════════════════════
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
      'cycle_id', h.cycle_id,
      'overall', h.overall,
      'sum_score', h.sum_score,
      'by_category', h.by_category,
      'nps', h.nps,
      'comment', h.comment,
      'submitted_at', h.answered_at
    ) order by h.period asc
  ), '[]'::jsonb)
  into v_result
  from (
    select
      c.id as cycle_id,
      c.period,
      round(avg(a.score::numeric) filter (
        where a.score is not null and q.type in ('weather5','scale')), 3) as overall,
      sum(a.score) filter (
        where a.score is not null and q.type in ('weather5','scale')) as sum_score,
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
      r.comment,
      r.answered_at
    from public.pulse_responses r
    join public.pulse_cycles c on c.id = r.cycle_id
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.employee_number = v_emp
      and c.status in ('sent','closed')
    group by c.id, c.period, r.id, r.answered_at
  ) h;

  return v_result;
end;
$$;

-- (既存 grant は 0045 でこのシグネチャへ既に付与済み・不変のため再掲不要)

-- ══ 3-8. pulse_notifications: reminder_no 列 ＋ 複合 index ═══════════
alter table public.pulse_notifications
  add column if not exists reminder_no smallint;

create index if not exists pulse_notifications_cycle_emp_kind_idx
  on public.pulse_notifications (cycle_id, employee_number, kind);

-- ══ 3-10. RLS 締め: pulse_question_sets / pulse_questions / pulse_cycles
--          の SELECT を「pulse_is_admin() or pulse_scope() <> 'self'」に。
--          回答者はテーブル直読せず §3-4/§3-6 の RPC 経由に切替（フロント
--          側の直読撤去は usePulseStore.ts・別エージェント担当）。
--          書込みポリシーは不変。ポリシー名は既存名を維持。 ═════════════
drop policy if exists "pulse_question_sets read (authenticated)" on public.pulse_question_sets;
create policy "pulse_question_sets read (authenticated)"
  on public.pulse_question_sets for select to authenticated
  using (public.pulse_is_admin() or public.pulse_scope() <> 'self');

drop policy if exists "pulse_questions read (authenticated)" on public.pulse_questions;
create policy "pulse_questions read (authenticated)"
  on public.pulse_questions for select to authenticated
  using (public.pulse_is_admin() or public.pulse_scope() <> 'self');

drop policy if exists "pulse_cycles read (authenticated)" on public.pulse_cycles;
create policy "pulse_cycles read (authenticated)"
  on public.pulse_cycles for select to authenticated
  using (public.pulse_is_admin() or public.pulse_scope() <> 'self');

commit;
