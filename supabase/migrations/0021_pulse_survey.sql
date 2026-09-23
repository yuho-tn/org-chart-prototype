-- ─────────────────────────────────────────────────────────────────────
-- 0021_pulse_survey
--
-- #4 パルスサーベイ アドオン スライス1: データ基盤。
-- 元リポ taishin-create/shosan-pulse-survey の prisma/schema.prisma を正と
-- し、Supabase ネイティブへ snake_case ＋ employee_number FK 化で再設計。
-- ミッションシート 0018/0019 の増設パターン（enum ガード / SECURITY DEFINER
-- ヘルパー / RPC 経由書込み / 0017 方式 GRANT）に厳密に倣う。
--
-- Prisma → 0021 対応:
--   QuestionSet       → pulse_question_sets（draft→active→archived 不可変ガード）
--   Question          → pulse_questions（sort_order・親 draft のみ可変ガード）
--   SurveyCycle       → pulse_cycles（period text UNIQUE 'YYYY-MM'・状態一方向）
--   Response          → pulse_responses（employee_number FK・回答時スナップショット
--                        snap_department/employment_type/position_title・RPC 書込み）
--   Answer            → pulse_answers（score 1-5 / value_text・RPC 書込み）
--   Alert             → pulse_alerts（reason jsonb・RPC 書込み）
--   AlertAction       → pulse_alert_actions（担当=assignee_employee_number）
--   AlertRule         → pulse_alert_rules（params jsonb・既定2ルール seed）
--   MonthlyAggregate  → pulse_monthly_aggregates（dimension=total/department/
--                        employment_type/position_title・metrics jsonb・n<5 マスク）
--   Role + UserRole   → pulse_access に統合（email PK・can_view_realname /
--                        scope(all/own_unit/self) / own_unit_departments[] /
--                        can_manage_alert。master・privileged_admin は自動フル）
--   Notification      → pulse_notifications（RPC 書込み・スライス7）
-- 捨てるモデル: Organization/JobType/RoleTier（employees の生 text 属性に相乗り）、
--   UserAttributeHistory（回答時スナップショットで代替）、BenchmarkValue（業界平均
--   ＝v1 スコープ外）。enum は使わず全ステータスは text+check（拡張容易）。
--
-- SQL 関数（スコアリング/集計/アラート判定）:
--   pulse_submit_response()    — 回答の唯一の書込み経路。属性スナップショット凍結
--   pulse_compute_aggregates() — dimension 別平均・回答数を算出、n<5 マスク
--   pulse_evaluate_alerts()    — alert_rules を適用（absolute / delta）
--
-- 本人特定: pulse_current_employee_number() = employees.email ↔ auth.email()
--   （在籍者 left_at is null 限定）。app_users 未登録の一般社員もカバー。
--   ※ employees.email の充足率/重複はスライス2 配線時に認証セッションで実測確認。
--
-- 既存資産を再利用: employees（0002/0003）、app_users.role（0008/0011）、
--   touch_updated_at()（0002）。0015 の survey.* module_permissions 行は本機能
--   では未使用（pulse_access が per-person 権限を担う）→ 死蔵のまま触らない。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 1. 設問（バージョン管理） ════════════════════════════════════════
create table if not exists public.pulse_question_sets (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  version integer not null default 1,
  status text not null default 'draft'
    check (status in ('draft','active','archived')),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text
);

create index if not exists pulse_question_sets_status_idx
  on public.pulse_question_sets (status);

drop trigger if exists pulse_question_sets_touch_updated_at on public.pulse_question_sets;
create trigger pulse_question_sets_touch_updated_at
  before update on public.pulse_question_sets
  for each row execute function public.touch_updated_at();

-- 不可変ガード（mission_templates 方式）:
--   INSERT は draft のみ / status 遷移は draft→active→archived の一方向 /
--   draft 以外は name・version 変更不可（active→archived の status のみ許可）/
--   DELETE は draft のみ。active 化時に activated_at を自動スタンプ。
create or replace function public.pulse_question_sets_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.status <> 'draft' then
      raise exception 'pulse_question_sets: only draft sets can be deleted (status=%)', OLD.status;
    end if;
    return OLD;
  end if;

  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then
      raise exception 'pulse_question_sets: new sets must be created as draft (status=%)', NEW.status;
    end if;
    return NEW;
  end if;

  -- UPDATE
  if NEW.status is distinct from OLD.status then
    if not (
      (OLD.status = 'draft' and NEW.status = 'active')
      or (OLD.status = 'active' and NEW.status = 'archived')
    ) then
      raise exception 'pulse_question_sets: invalid status transition % -> %', OLD.status, NEW.status;
    end if;
    if NEW.status = 'active' and NEW.activated_at is null then
      NEW.activated_at := now();
    end if;
  end if;

  if OLD.status <> 'draft' then
    if NEW.name is distinct from OLD.name
      or NEW.version is distinct from OLD.version
    then
      raise exception 'pulse_question_sets: % set is immutable (only status active -> archived is allowed)', OLD.status;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists pulse_question_sets_guard on public.pulse_question_sets;
create trigger pulse_question_sets_guard
  before insert or update or delete on public.pulse_question_sets
  for each row execute function public.pulse_question_sets_guard();

create table if not exists public.pulse_questions (
  id uuid primary key default gen_random_uuid(),
  question_set_id uuid not null references public.pulse_question_sets(id) on delete cascade,
  sort_order integer not null default 0,     -- Prisma "order"（予約語回避）
  label text not null,
  category text,                             -- 仕事 / 対人 / 健康 / 評価 等
  type text not null default 'weather5'
    check (type in ('weather5','scale','free_text')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pulse_questions_set_idx
  on public.pulse_questions (question_set_id, sort_order);

drop trigger if exists pulse_questions_touch_updated_at on public.pulse_questions;
create trigger pulse_questions_touch_updated_at
  before update on public.pulse_questions
  for each row execute function public.touch_updated_at();

-- 親セットが draft のときのみ設問を可変にする（active/archived 後は凍結）。
create or replace function public.pulse_questions_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_set uuid;
  v_status text;
begin
  v_set := case when TG_OP = 'DELETE' then OLD.question_set_id else NEW.question_set_id end;
  select status into v_status from public.pulse_question_sets where id = v_set;
  if TG_OP = 'DELETE' then
    -- 親が既に消えている（draft セット削除の FK cascade）→ 許可。
    -- 親が存命かつ draft でない場合のみ単発 DELETE を凍結。
    if v_status is not null and v_status <> 'draft' then
      raise exception 'pulse_questions: parent question set is not draft (status=%) — questions are frozen', v_status;
    end if;
    return OLD;
  end if;
  -- INSERT / UPDATE: 親は存命かつ draft 必須。
  if v_status is distinct from 'draft' then
    raise exception 'pulse_questions: parent question set is not draft (status=%) — questions are frozen', coalesce(v_status, '(missing)');
  end if;
  return NEW;
end;
$$;

drop trigger if exists pulse_questions_guard on public.pulse_questions;
create trigger pulse_questions_guard
  before insert or update or delete on public.pulse_questions
  for each row execute function public.pulse_questions_guard();

-- ══ 2. 配信サイクル ══════════════════════════════════════════════════
create table if not exists public.pulse_cycles (
  id uuid primary key default gen_random_uuid(),
  period text not null unique
    check (period ~ '^\d{4}-\d{2}$'),        -- YYYY-MM（月次）
  question_set_id uuid not null references public.pulse_question_sets(id),
  send_date date,
  due_date date,
  status text not null default 'scheduled'
    check (status in ('scheduled','sent','closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pulse_cycles_status_idx
  on public.pulse_cycles (status);

drop trigger if exists pulse_cycles_touch_updated_at on public.pulse_cycles;
create trigger pulse_cycles_touch_updated_at
  before update on public.pulse_cycles
  for each row execute function public.touch_updated_at();

-- 状態は scheduled→sent→closed の一方向のみ（closed の再オープン＝遅延回答
-- の混入を防ぐ）。sent 以降は period / question_set_id を凍結。
create or replace function public.pulse_cycles_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.status is distinct from OLD.status then
      if not (
        (OLD.status = 'scheduled' and NEW.status = 'sent')
        or (OLD.status = 'sent' and NEW.status = 'closed')
      ) then
        raise exception 'pulse_cycles: invalid status transition % -> %', OLD.status, NEW.status;
      end if;
    end if;
    if OLD.status <> 'scheduled' then
      if NEW.period is distinct from OLD.period
        or NEW.question_set_id is distinct from OLD.question_set_id
      then
        raise exception 'pulse_cycles: period / question set are frozen after send (status=%)', OLD.status;
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists pulse_cycles_guard on public.pulse_cycles;
create trigger pulse_cycles_guard
  before update on public.pulse_cycles
  for each row execute function public.pulse_cycles_guard();

-- ══ 3. 回答（回答時点の属性をスナップショット） ══════════════════════
-- 匿名性はストレージ層では持たない: employee_number を常に保持し（重複防止・
-- アラート・リマインドに必須）、「匿名」は読み取り層の概念（実名閲覧権が無い
-- 者には生行を見せず集計/コメントは脱識別 RPC＋n<5 マスクのみ）。
create table if not exists public.pulse_responses (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.pulse_cycles(id) on delete cascade,
  employee_number text not null references public.employees(employee_number),
  source text not null default 'native'
    check (source in ('native','geppo_import')),
  answered_at timestamptz,
  comment text,
  -- 回答時スナップショット（集計軸。employees の異動後も回答当時で固定）
  snap_department text,
  snap_employment_type text,
  snap_position_title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cycle_id, employee_number)         -- 社員×配信月の重複防止
);

create index if not exists pulse_responses_cycle_idx
  on public.pulse_responses (cycle_id);
create index if not exists pulse_responses_employee_idx
  on public.pulse_responses (employee_number);

drop trigger if exists pulse_responses_touch_updated_at on public.pulse_responses;
create trigger pulse_responses_touch_updated_at
  before update on public.pulse_responses
  for each row execute function public.touch_updated_at();

create table if not exists public.pulse_answers (
  id uuid primary key default gen_random_uuid(),
  response_id uuid not null references public.pulse_responses(id) on delete cascade,
  question_id uuid not null references public.pulse_questions(id),
  score integer check (score between 1 and 5),  -- weather5 / scale
  value_text text,                              -- free_text
  created_at timestamptz not null default now(),
  unique (response_id, question_id)
);

create index if not exists pulse_answers_response_idx
  on public.pulse_answers (response_id);
create index if not exists pulse_answers_question_idx
  on public.pulse_answers (question_id);

-- ══ 4. アラート ══════════════════════════════════════════════════════
create table if not exists public.pulse_alerts (
  id uuid primary key default gen_random_uuid(),
  employee_number text not null references public.employees(employee_number),
  cycle_id uuid not null references public.pulse_cycles(id) on delete cascade,
  type text not null check (type in ('absolute','delta','custom')),
  reason jsonb not null default '{}'::jsonb,     -- 根拠（Prisma は JSON 文字列）
  status text not null default 'open'
    check (status in ('open','closed')),
  created_at timestamptz not null default now(),
  unique (employee_number, cycle_id, type)
);

create index if not exists pulse_alerts_cycle_idx
  on public.pulse_alerts (cycle_id);
create index if not exists pulse_alerts_employee_idx
  on public.pulse_alerts (employee_number);

create table if not exists public.pulse_alert_actions (
  id uuid primary key default gen_random_uuid(),
  alert_id uuid not null references public.pulse_alerts(id) on delete cascade,
  assignee_employee_number text references public.employees(employee_number),
  state text not null default 'todo'
    check (state in ('todo','doing','done')),
  due_date date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pulse_alert_actions_alert_idx
  on public.pulse_alert_actions (alert_id);

drop trigger if exists pulse_alert_actions_touch_updated_at on public.pulse_alert_actions;
create trigger pulse_alert_actions_touch_updated_at
  before update on public.pulse_alert_actions
  for each row execute function public.touch_updated_at();

create table if not exists public.pulse_alert_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,                     -- seed 冪等キー
  type text not null check (type in ('absolute','delta','custom')),
  params jsonb not null default '{}'::jsonb,      -- {"threshold":2} / {"drop":1.5}
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists pulse_alert_rules_touch_updated_at on public.pulse_alert_rules;
create trigger pulse_alert_rules_touch_updated_at
  before update on public.pulse_alert_rules
  for each row execute function public.touch_updated_at();

-- ══ 5. 集計・通知 ════════════════════════════════════════════════════
create table if not exists public.pulse_monthly_aggregates (
  id uuid primary key default gen_random_uuid(),
  period text not null,
  dimension text not null
    check (dimension in ('total','department','employment_type','position_title')),
  dimension_key text not null default '',
  metrics jsonb not null default '{}'::jsonb,     -- {n, masked, avg_overall, ...}
  created_at timestamptz not null default now(),
  unique (period, dimension, dimension_key)
);

create index if not exists pulse_monthly_aggregates_period_idx
  on public.pulse_monthly_aggregates (period);

create table if not exists public.pulse_notifications (
  id uuid primary key default gen_random_uuid(),
  cycle_id uuid not null references public.pulse_cycles(id) on delete cascade,
  employee_number text not null references public.employees(employee_number),
  channel text not null default 'slack'
    check (channel in ('slack','email')),
  kind text not null check (kind in ('broadcast','reminder')),
  sent_at timestamptz not null default now(),
  status text not null default 'sent'
    check (status in ('sent','failed'))
);

create index if not exists pulse_notifications_cycle_idx
  on public.pulse_notifications (cycle_id);

-- ══ 6. 権限（pulse 専用・Role+UserRole 統合置換） ════════════════════
-- email 主キー（auth.email() / app_users と揃える）。master・privileged_admin
-- は本テーブルに行が無くても pulse_is_admin() 経由で自動フル。
create table if not exists public.pulse_access (
  email text primary key check (email = lower(email)),  -- 参照側 lower() と一致保証
  can_view_realname boolean not null default false,
  scope text not null default 'self'
    check (scope in ('all','own_unit','self')),
  own_unit_departments text[] not null default array[]::text[],
  can_manage_alert boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text
);

drop trigger if exists pulse_access_touch_updated_at on public.pulse_access;
create trigger pulse_access_touch_updated_at
  before update on public.pulse_access
  for each row execute function public.touch_updated_at();

-- ══ 7. SECURITY DEFINER ヘルパー ═════════════════════════════════════

-- 本人特定: employees.email ↔ auth.email()（在籍者のみ・空メールは非マッチ）。
create or replace function public.pulse_current_employee_number()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select e.employee_number
  from public.employees e
  where e.left_at is null
    and coalesce(btrim(e.email), '') <> ''
    and lower(btrim(e.email)) = lower(coalesce(auth.email(), ''))
  order by e.employee_number
  limit 1
$$;

-- パルス管理者（サーベイ構成の作成・発行・集計/アラート判定の実行）。
create or replace function public.pulse_is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.app_users
    where email = lower(coalesce(auth.email(), ''))
      and role in ('master', 'privileged_admin')
  )
$$;

-- 実名閲覧権: admin OR pulse_access.can_view_realname。
create or replace function public.pulse_can_view_realname()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.pulse_is_admin()
    or exists (
      select 1 from public.pulse_access
      where email = lower(coalesce(auth.email(), ''))
        and can_view_realname
    )
$$;

-- アラート管理権: admin OR pulse_access.can_manage_alert。
create or replace function public.pulse_can_manage_alert()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.pulse_is_admin()
    or exists (
      select 1 from public.pulse_access
      where email = lower(coalesce(auth.email(), ''))
        and can_manage_alert
    )
$$;

-- スコープ: admin→'all'、pulse_access 未登録→'self'。
create or replace function public.pulse_scope()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select case
    when public.pulse_is_admin() then 'all'
    else coalesce((
      select scope from public.pulse_access
      where email = lower(coalesce(auth.email(), ''))
    ), 'self')
  end
$$;

-- 対象社員を閲覧できるか（scope 判定）。self は常に自分だけ true。
create or replace function public.pulse_can_view_employee(p_employee_number text)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_scope text := public.pulse_scope();
  v_units text[];
  v_dept text;
begin
  if v_scope = 'all' then
    return true;
  end if;
  if p_employee_number is not null
    and p_employee_number = public.pulse_current_employee_number()
  then
    return true;                              -- 本人は常に本人を見られる
  end if;
  if v_scope = 'own_unit' then
    select own_unit_departments into v_units
    from public.pulse_access
    where email = lower(coalesce(auth.email(), ''));
    select department into v_dept
    from public.employees
    where employee_number = p_employee_number;
    return v_dept is not null
      and btrim(v_dept) <> ''
      and v_dept = any (coalesce(v_units, array[]::text[]));
  end if;
  return false;                              -- self scope: 本人以外は不可
end;
$$;

-- ══ 8. RPC: pulse_submit_response（回答の唯一の書込み経路） ═══════════
-- cycle=sent 検証 → 本人 emp 解決 → 属性スナップショット凍結 →
-- responses upsert（回答中の再送信で上書き）→ answers 総入れ替え。
-- p_answers = [{"question_id":"<uuid>","score":3,"value_text":null}, ...]
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
    -- 設問が当サイクルの設問セットに属し active であることを検証
    if not exists (
      select 1 from public.pulse_questions q
      where q.id = v_qid::uuid
        and q.question_set_id = v_qset
        and q.is_active
    ) then
      raise exception 'pulse_submit_response: question % is not in the active set for this cycle', v_qid;
    end if;
    insert into public.pulse_answers (response_id, question_id, score, value_text)
    values (
      v_response_id,
      v_qid::uuid,
      nullif(v_ans->>'score', '')::integer,
      nullif(v_ans->>'value_text', '')
    );
  end loop;

  return v_response_id;
end;
$$;

-- ══ 9. RPC: pulse_compute_aggregates（スコアリング/集計） ═════════════
-- 指定 period のサイクルを dimension 別（total / 部署 / 雇用形態 / 役職）に
-- 集計。回答当時のスナップショット属性を軸に、平均総合スコアと回答数を算出し
-- pulse_monthly_aggregates へ upsert。n<5 のセルは値をマスク。
-- ※ 天気分布・カテゴリ別平均は metrics jsonb を拡張してスライス3 で追加。
create or replace function public.pulse_compute_aggregates(p_period text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle_id uuid;
  v_rows integer := 0;
begin
  if not (public.pulse_is_admin() or public.pulse_can_manage_alert()) then
    raise exception 'pulse_compute_aggregates: permission denied';
  end if;

  select id into v_cycle_id from public.pulse_cycles where period = p_period;
  if not found then
    raise exception 'pulse_compute_aggregates: no cycle for period %', p_period;
  end if;

  delete from public.pulse_monthly_aggregates where period = p_period;

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
    select dimension, dimension_key,
           count(*) as n,
           round(avg(overall), 3) as avg_overall
    from dims
    group by dimension, dimension_key
  )
  insert into public.pulse_monthly_aggregates (period, dimension, dimension_key, metrics)
  select p_period, dimension, dimension_key,
    case when n < 5
      then jsonb_build_object('n', n, 'masked', true)
      else jsonb_build_object('n', n, 'masked', false, 'avg_overall', avg_overall)
    end
  from agg;

  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- ══ 10. RPC: pulse_evaluate_alerts（アラート判定） ═══════════════════
-- 有効な alert_rules を適用し pulse_alerts を upsert。
--   absolute: 本人の平均総合スコア <= params.threshold（既定 2）
--   delta:    前サイクル比の下落 >= params.drop（既定 1.5）
-- unique(employee_number, cycle_id, type) により同型は1件に集約。
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
               avg(a.score::numeric) filter (where a.score is not null) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
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
               avg(a.score::numeric) filter (where a.score is not null) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
        where r.cycle_id = p_cycle_id
        group by r.employee_number
      ) cur
      join (
        select r.employee_number,
               avg(a.score::numeric) filter (where a.score is not null) as overall
        from public.pulse_responses r
        join public.pulse_answers a on a.response_id = r.id
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

-- ══ 11. RLS ══════════════════════════════════════════════════════════
alter table public.pulse_question_sets enable row level security;
alter table public.pulse_questions enable row level security;
alter table public.pulse_cycles enable row level security;
alter table public.pulse_responses enable row level security;
alter table public.pulse_answers enable row level security;
alter table public.pulse_alerts enable row level security;
alter table public.pulse_alert_actions enable row level security;
alter table public.pulse_alert_rules enable row level security;
alter table public.pulse_monthly_aggregates enable row level security;
alter table public.pulse_notifications enable row level security;
alter table public.pulse_access enable row level security;

-- ── 設問セット / 設問 / サイクル: 閲覧 authenticated 全員（回答画面描画）、
--    書込みは admin（＋各不可変ガード）。
drop policy if exists "pulse_question_sets read (authenticated)" on public.pulse_question_sets;
create policy "pulse_question_sets read (authenticated)"
  on public.pulse_question_sets for select to authenticated using (true);
drop policy if exists "pulse_question_sets write (admin)" on public.pulse_question_sets;
create policy "pulse_question_sets write (admin)"
  on public.pulse_question_sets for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

drop policy if exists "pulse_questions read (authenticated)" on public.pulse_questions;
create policy "pulse_questions read (authenticated)"
  on public.pulse_questions for select to authenticated using (true);
drop policy if exists "pulse_questions write (admin)" on public.pulse_questions;
create policy "pulse_questions write (admin)"
  on public.pulse_questions for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

drop policy if exists "pulse_cycles read (authenticated)" on public.pulse_cycles;
create policy "pulse_cycles read (authenticated)"
  on public.pulse_cycles for select to authenticated using (true);
drop policy if exists "pulse_cycles write (admin)" on public.pulse_cycles;
create policy "pulse_cycles write (admin)"
  on public.pulse_cycles for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

-- ── 回答 / 設問回答: SELECT のみ（本人 OR 実名閲覧権 AND scope）。
--    書込みポリシー無し＝クライアント直書き全面禁止、RPC 経由のみ。
drop policy if exists "pulse_responses read (own or realname+scope)" on public.pulse_responses;
create policy "pulse_responses read (own or realname+scope)"
  on public.pulse_responses for select to authenticated
  using (
    employee_number = public.pulse_current_employee_number()
    or (public.pulse_can_view_realname() and public.pulse_can_view_employee(employee_number))
  );

drop policy if exists "pulse_answers read (via response)" on public.pulse_answers;
create policy "pulse_answers read (via response)"
  on public.pulse_answers for select to authenticated
  using (exists (
    select 1 from public.pulse_responses r
    where r.id = response_id
      and (
        r.employee_number = public.pulse_current_employee_number()
        or (public.pulse_can_view_realname() and public.pulse_can_view_employee(r.employee_number))
      )
  ));

-- ── アラート: SELECT のみ（can_manage_alert AND scope）。RPC 書込み。
drop policy if exists "pulse_alerts read (manage_alert+scope)" on public.pulse_alerts;
create policy "pulse_alerts read (manage_alert+scope)"
  on public.pulse_alerts for select to authenticated
  using (public.pulse_can_manage_alert() and public.pulse_can_view_employee(employee_number));

-- ── 対応管理: SELECT / INSERT / UPDATE（can_manage_alert AND 親アラートの
--    社員が scope 内）。DELETE 不可。
drop policy if exists "pulse_alert_actions read (manage_alert+scope)" on public.pulse_alert_actions;
create policy "pulse_alert_actions read (manage_alert+scope)"
  on public.pulse_alert_actions for select to authenticated
  using (exists (
    select 1 from public.pulse_alerts al
    where al.id = alert_id
      and public.pulse_can_manage_alert()
      and public.pulse_can_view_employee(al.employee_number)
  ));
drop policy if exists "pulse_alert_actions insert (manage_alert+scope)" on public.pulse_alert_actions;
create policy "pulse_alert_actions insert (manage_alert+scope)"
  on public.pulse_alert_actions for insert to authenticated
  with check (exists (
    select 1 from public.pulse_alerts al
    where al.id = alert_id
      and public.pulse_can_manage_alert()
      and public.pulse_can_view_employee(al.employee_number)
  ));
drop policy if exists "pulse_alert_actions update (manage_alert+scope)" on public.pulse_alert_actions;
create policy "pulse_alert_actions update (manage_alert+scope)"
  on public.pulse_alert_actions for update to authenticated
  using (exists (
    select 1 from public.pulse_alerts al
    where al.id = alert_id
      and public.pulse_can_manage_alert()
      and public.pulse_can_view_employee(al.employee_number)
  ))
  with check (exists (
    select 1 from public.pulse_alerts al
    where al.id = alert_id
      and public.pulse_can_manage_alert()
      and public.pulse_can_view_employee(al.employee_number)
  ));

-- ── アラートルール: admin のみ（閲覧・書込みとも）。
drop policy if exists "pulse_alert_rules all (admin)" on public.pulse_alert_rules;
create policy "pulse_alert_rules all (admin)"
  on public.pulse_alert_rules for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

-- ── 集計: 閲覧は pulse_access 保有者 or admin（ダッシュボードは権限者のみ）。
--    RPC 書込みのみ。脱識別済＋n<5 マスクだが権限者に限定。
drop policy if exists "pulse_monthly_aggregates read (access holders)" on public.pulse_monthly_aggregates;
create policy "pulse_monthly_aggregates read (access holders)"
  on public.pulse_monthly_aggregates for select to authenticated
  using (
    public.pulse_is_admin()
    or exists (
      select 1 from public.pulse_access
      where email = lower(coalesce(auth.email(), ''))
    )
  );

-- ── 通知: SELECT のみ（can_manage_alert）。RPC 書込み（スライス7）。
drop policy if exists "pulse_notifications read (manage_alert)" on public.pulse_notifications;
create policy "pulse_notifications read (manage_alert)"
  on public.pulse_notifications for select to authenticated
  using (public.pulse_can_manage_alert());

-- ── 権限テーブル: 自分の行 OR admin を閲覧。書込みは admin のみ。
drop policy if exists "pulse_access read (own or admin)" on public.pulse_access;
create policy "pulse_access read (own or admin)"
  on public.pulse_access for select to authenticated
  using (email = lower(coalesce(auth.email(), '')) or public.pulse_is_admin());
drop policy if exists "pulse_access write (admin)" on public.pulse_access;
create policy "pulse_access write (admin)"
  on public.pulse_access for all to authenticated
  using (public.pulse_is_admin()) with check (public.pulse_is_admin());

-- ══ 12. GRANT（0017 方式: anon revoke all・書込み面を最小化） ════════
revoke all on public.pulse_question_sets from anon;
revoke all on public.pulse_questions from anon;
revoke all on public.pulse_cycles from anon;
revoke all on public.pulse_responses from anon;
revoke all on public.pulse_answers from anon;
revoke all on public.pulse_alerts from anon;
revoke all on public.pulse_alert_actions from anon;
revoke all on public.pulse_alert_rules from anon;
revoke all on public.pulse_monthly_aggregates from anon;
revoke all on public.pulse_notifications from anon;
revoke all on public.pulse_access from anon;

-- 手管理テーブル: DML を authenticated へ（RLS がゲート）。
grant select, insert, update, delete on public.pulse_question_sets to authenticated;
grant select, insert, update, delete on public.pulse_questions to authenticated;
grant select, insert, update, delete on public.pulse_cycles to authenticated;
grant select, insert, update, delete on public.pulse_alert_rules to authenticated;
grant select, insert, update, delete on public.pulse_access to authenticated;
-- alert_actions は DELETE 不可（ポリシー不在＋GRANT 不在の二重防御）。
revoke delete on public.pulse_alert_actions from authenticated;
grant select, insert, update on public.pulse_alert_actions to authenticated;

-- RPC 専有テーブル: SELECT のみ（書込みは SECURITY DEFINER が担う多層防御）。
revoke insert, update, delete on public.pulse_responses from authenticated;
grant select on public.pulse_responses to authenticated;
revoke insert, update, delete on public.pulse_answers from authenticated;
grant select on public.pulse_answers to authenticated;
revoke insert, update, delete on public.pulse_alerts from authenticated;
grant select on public.pulse_alerts to authenticated;
revoke insert, update, delete on public.pulse_monthly_aggregates from authenticated;
grant select on public.pulse_monthly_aggregates to authenticated;
revoke insert, update, delete on public.pulse_notifications from authenticated;
grant select on public.pulse_notifications to authenticated;

-- 関数: default の PUBLIC EXECUTE を剥がし authenticated/service_role へ明示付与。
revoke all on function public.pulse_current_employee_number() from public, anon;
revoke all on function public.pulse_is_admin() from public, anon;
revoke all on function public.pulse_can_view_realname() from public, anon;
revoke all on function public.pulse_can_manage_alert() from public, anon;
revoke all on function public.pulse_scope() from public, anon;
revoke all on function public.pulse_can_view_employee(text) from public, anon;
revoke all on function public.pulse_submit_response(uuid, jsonb, text) from public, anon;
revoke all on function public.pulse_compute_aggregates(text) from public, anon;
revoke all on function public.pulse_evaluate_alerts(uuid) from public, anon;

grant execute on function public.pulse_current_employee_number() to authenticated, service_role;
grant execute on function public.pulse_is_admin() to authenticated, service_role;
grant execute on function public.pulse_can_view_realname() to authenticated, service_role;
grant execute on function public.pulse_can_manage_alert() to authenticated, service_role;
grant execute on function public.pulse_scope() to authenticated, service_role;
grant execute on function public.pulse_can_view_employee(text) to authenticated, service_role;
grant execute on function public.pulse_submit_response(uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.pulse_compute_aggregates(text) to authenticated, service_role;
grant execute on function public.pulse_evaluate_alerts(uuid) to authenticated, service_role;

-- ══ 13. seed: 既定アラートルール（運用変更は上書きしない） ════════════
insert into public.pulse_alert_rules (name, type, params) values
  ('絶対値アラート（平均2以下）', 'absolute', '{"threshold": 2}'::jsonb),
  ('変化量アラート（1.5以上の下落）', 'delta', '{"drop": 1.5}'::jsonb)
on conflict (name) do nothing;

commit;
