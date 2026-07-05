-- ─────────────────────────────────────────────────────────────────────
-- 0018_mission_sheets
--
-- P2: ミッションシート（目標管理・査定連携の土台）。第1弾スコープは
-- テンプレ管理＋発行＋本人記入＋上長確認だが、スキーマ・enum・ステージ
-- 遷移は全段階（期初〜査定確定）分をここで一括定義する。Adds:
--   • Enums: mission_stage, mission_respondent
--   • mission_templates    — 期ごとのシートテンプレ（definition jsonb）。
--                            同一期に複数テンプレ可（キャリアトラック別）。
--                            published は不可変（トリガで強制）。
--   • mission_sheets       — 従業員×期に1枚のシート実体。stage 管理。
--                            クライアント直書き不可（RPC 経由のみ）。
--   • mission_answers      — 設問回答（self / evaluator 行を分離）。
--   • mission_stage_events — ステージ遷移の監査ログ（RPC 内のみ書込み）。
--   • SECURITY DEFINER ヘルパー:
--       is_mission_evaluator_of() / can_manage_missions() /
--       can_view_mission_sheet() / mission_can_write_answer()
--   • RPC: mission_issue_sheets() / mission_set_stage()
--   • RLS + GRANT — 0017 方式（anon から revoke all、書込み面を最小化）
--   • module_permissions seed: ('mission','manage'), ('mission','evaluate_any')
--
-- 既存資産を再利用: period_code / evaluation_grade（0013）、
-- current_employee_number() / current_position_level() /
-- has_module_permission()（0015）、touch_updated_at()（0006）。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ── 1. Enums ────────────────────────────────────────────────────────
do $$ begin
  create type public.mission_stage as enum
    ('issued','goal_submitted','goal_confirmed','mid_done','final_submitted','assessed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.mission_respondent as enum ('self','evaluator');
exception when duplicate_object then null; end $$;

-- ── 2. mission_templates ────────────────────────────────────────────
create table if not exists public.mission_templates (
  id uuid primary key default gen_random_uuid(),
  -- 同一期に複数テンプレ可（キャリアトラック別テンプレを許容）→ UNIQUE なし
  period public.period_code not null,
  title text not null,
  definition jsonb not null default '{"sections":[]}'::jsonb,
  -- {"goal":"2026-07-31","mid":"...","final":"..."}（ISO 日付文字列）
  deadlines jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','published','archived')),
  calc_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by_email text
);

create index if not exists mission_templates_period_idx
  on public.mission_templates (period);

drop trigger if exists mission_templates_touch_updated_at on public.mission_templates;
create trigger mission_templates_touch_updated_at
  before update on public.mission_templates
  for each row execute function public.touch_updated_at();

-- published / archived 不可変ガード:
--   • INSERT は status='draft' のみ（published/archived の直作成を拒否）
--   • status 遷移は draft→published→archived の一方向のみ
--     （archived は status 変更も一切不可）
--   • draft 以外（published / archived）の行は period/title/definition/
--     deadlines/calc_version を変更不可（published→archived の status
--     変更のみ許可）
--   • DELETE は draft のみ（published / archived は削除不可）
create or replace function public.mission_templates_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'DELETE' then
    if OLD.status <> 'draft' then
      raise exception 'mission_templates: only draft templates can be deleted (status=%)', OLD.status;
    end if;
    return OLD;
  end if;

  -- INSERT: draft 以外での直作成を拒否
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then
      raise exception 'mission_templates: new templates must be created as draft (status=%)', NEW.status;
    end if;
    return NEW;
  end if;

  -- UPDATE: status は一方向遷移のみ
  if NEW.status is distinct from OLD.status then
    if not (
      (OLD.status = 'draft' and NEW.status = 'published')
      or (OLD.status = 'published' and NEW.status = 'archived')
    ) then
      raise exception 'mission_templates: invalid status transition % -> %', OLD.status, NEW.status;
    end if;
  end if;

  -- draft 以外（published / archived）は内容不可変
  -- （published→archived の status 変更だけを通す）
  if OLD.status <> 'draft' then
    if NEW.period is distinct from OLD.period
      or NEW.title is distinct from OLD.title
      or NEW.definition is distinct from OLD.definition
      or NEW.deadlines is distinct from OLD.deadlines
      or NEW.calc_version is distinct from OLD.calc_version
    then
      raise exception 'mission_templates: % template is immutable (only status published -> archived is allowed)', OLD.status;
    end if;
  end if;

  return NEW;
end;
$$;

drop trigger if exists mission_templates_guard on public.mission_templates;
create trigger mission_templates_guard
  before insert or update or delete on public.mission_templates
  for each row execute function public.mission_templates_guard();

-- ── 3. mission_sheets ───────────────────────────────────────────────
create table if not exists public.mission_sheets (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.mission_templates(id),
  employee_number text not null references public.employees(employee_number),
  -- テンプレから複写（非正規化）: (employee_number, period) 一意性のため
  period public.period_code not null,
  stage public.mission_stage not null default 'issued',
  computed_result jsonb,                     -- 第2弾用（今回は常に null）
  final_grade public.evaluation_grade,       -- 第2弾用
  issued_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (employee_number, period)
);

create index if not exists mission_sheets_template_idx
  on public.mission_sheets (template_id);
create index if not exists mission_sheets_period_idx
  on public.mission_sheets (period);

drop trigger if exists mission_sheets_touch_updated_at on public.mission_sheets;
create trigger mission_sheets_touch_updated_at
  before update on public.mission_sheets
  for each row execute function public.touch_updated_at();

-- ── 4. mission_answers ──────────────────────────────────────────────
create table if not exists public.mission_answers (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references public.mission_sheets(id) on delete cascade,
  question_id text not null,
  respondent_role public.mission_respondent not null,
  value jsonb not null,
  author_email text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sheet_id, question_id, respondent_role)
);

create index if not exists mission_answers_sheet_idx
  on public.mission_answers (sheet_id);

drop trigger if exists mission_answers_touch_updated_at on public.mission_answers;
create trigger mission_answers_touch_updated_at
  before update on public.mission_answers
  for each row execute function public.touch_updated_at();

-- ── 5. mission_stage_events ─────────────────────────────────────────
create table if not exists public.mission_stage_events (
  id uuid primary key default gen_random_uuid(),
  sheet_id uuid not null references public.mission_sheets(id) on delete cascade,
  from_stage public.mission_stage,           -- null = 発行（初回）
  to_stage public.mission_stage not null,
  actor_email text not null,
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists mission_stage_events_sheet_idx
  on public.mission_stage_events (sheet_id, created_at);

-- ── 6. SECURITY DEFINER ヘルパー ─────────────────────────────────────

-- 自分が p_employee_number の評価者か。
--   (同一部署の完全一致 AND 自分の役職レベル > 対象の役職レベル)
--   OR has_module_permission('mission','evaluate_any')
-- レベルは position_levels.level（未登録役職は 0）。actor が app_users に
-- 未紐付けなら部署比較側は false（evaluate_any 側は生きる）。
-- 自分自身は常に false（level 比較で自明だが同姓 level ガードとして明示）。
create or replace function public.is_mission_evaluator_of(p_employee_number text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    exists (
      select 1
      from public.app_users au
      join public.employees actor
        on actor.employee_number = au.employee_number
      join public.employees target
        on target.employee_number = p_employee_number
      left join public.position_levels apl
        on apl.position_title = actor.position_title
      left join public.position_levels tpl
        on tpl.position_title = target.position_title
      where au.email = lower(coalesce(auth.email(), ''))
        and actor.employee_number <> target.employee_number
        and actor.department is not null
        and btrim(actor.department) <> ''
        -- クライアントミラー（isEvaluatorOfClient）と同じ両側 trim 比較
        and btrim(actor.department) = btrim(target.department)
        and coalesce(apl.level, 0) > coalesce(tpl.level, 0)
    )
    or public.has_module_permission('mission', 'evaluate_any')
$$;

-- ミッション管理権限（テンプレ管理・発行・査定確定）
create or replace function public.can_manage_missions()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.has_module_permission('mission', 'manage')
$$;

-- シート閲覧可否: 本人 OR 評価者 OR 管理権限
create or replace function public.can_view_mission_sheet(p_sheet_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.mission_sheets s
    where s.id = p_sheet_id
      and (
        s.employee_number = public.current_employee_number()
        or public.is_mission_evaluator_of(s.employee_number)
        or public.can_manage_missions()
      )
  )
$$;

-- 回答書込み可否: テンプレ definition から question_id の phase /
-- respondent を引き、シートの stage・書き手のロールと突合する。
--   p_role='self':      本人のみ。
--     phase=goal  → stage in ('issued','goal_submitted')
--     phase=mid   → stage = 'goal_confirmed'
--     phase=final → stage = 'mid_done'
--   p_role='evaluator': 評価者 OR 管理権限。
--     phase=goal  → stage = 'goal_submitted'
--     phase=mid   → stage = 'goal_confirmed'
--     phase=final → stage = 'mid_done'
--   question_id がテンプレに無い / heading / respondent 不一致
--   （'self' 設問への evaluator 行など。'both' のみ両ロール可）/
--   stage='assessed' → false。
create or replace function public.mission_can_write_answer(
  p_sheet_id uuid,
  p_question_id text,
  p_role public.mission_respondent
)
returns boolean
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_employee_number text;
  v_stage public.mission_stage;
  v_template_id uuid;
  v_def jsonb;
  v_q jsonb;
  v_phase text;
  v_respondent text;
begin
  select s.employee_number, s.stage, s.template_id
    into v_employee_number, v_stage, v_template_id
  from public.mission_sheets s
  where s.id = p_sheet_id;
  if not found then
    return false;
  end if;

  -- 査定確定後は全設問 read-only
  if v_stage = 'assessed' then
    return false;
  end if;

  select t.definition into v_def
  from public.mission_templates t
  where t.id = v_template_id;
  if v_def is null then
    return false;
  end if;

  -- definition の sections[].questions[] から該当設問を検索
  select q.value into v_q
  from jsonb_array_elements(coalesce(v_def->'sections', '[]'::jsonb)) as sec(value),
       jsonb_array_elements(coalesce(sec.value->'questions', '[]'::jsonb)) as q(value)
  where q.value->>'id' = p_question_id
  limit 1;
  if v_q is null then
    return false;
  end if;

  -- heading は回答を持たない
  if v_q->>'type' = 'heading' then
    return false;
  end if;

  -- phase / respondent 未設定はクライアント側既定（questionPhase /
  -- questionRespondent）と同じ 'goal' / 'self' に倒す（判定逆転防止）
  v_phase := coalesce(v_q->>'phase', 'goal');
  v_respondent := coalesce(v_q->>'respondent', 'self');

  if p_role = 'self' then
    -- 'self' または 'both' の設問のみ本人行を書ける
    if v_respondent not in ('self', 'both') then
      return false;
    end if;
    if v_employee_number is distinct from public.current_employee_number()
      or public.current_employee_number() is null
    then
      return false;
    end if;
    return case v_phase
      when 'goal'  then v_stage in ('issued', 'goal_submitted')
      when 'mid'   then v_stage = 'goal_confirmed'
      when 'final' then v_stage = 'mid_done'
      else false
    end;
  else
    -- 'evaluator' または 'both' の設問のみ evaluator 行を書ける
    -- （'self' 設問への evaluator 行は拒否）
    if v_respondent not in ('evaluator', 'both') then
      return false;
    end if;
    if not (
      public.is_mission_evaluator_of(v_employee_number)
      or public.can_manage_missions()
    ) then
      return false;
    end if;
    return case v_phase
      when 'goal'  then v_stage = 'goal_submitted'
      when 'mid'   then v_stage = 'goal_confirmed'
      when 'final' then v_stage = 'mid_done'
      else false
    end;
  end if;
end;
$$;

-- ── 7. RPC: mission_issue_sheets ────────────────────────────────────
-- published テンプレを対象者へ一括発行。既存の (employee_number, period)
-- はスキップ（冪等）。作成件数を返す。can_manage_missions() 必須。
create or replace function public.mission_issue_sheets(
  p_template_id uuid,
  p_employee_numbers text[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period public.period_code;
  v_status text;
  v_emp text;
  v_sheet_id uuid;
  v_count integer := 0;
  v_actor text := lower(coalesce(auth.email(), ''));
begin
  if not public.can_manage_missions() then
    raise exception 'mission_issue_sheets: permission denied (mission.manage required)';
  end if;

  select t.period, t.status into v_period, v_status
  from public.mission_templates t
  where t.id = p_template_id;
  if not found then
    raise exception 'mission_issue_sheets: template % not found', p_template_id;
  end if;
  if v_status <> 'published' then
    raise exception 'mission_issue_sheets: template must be published (status=%)', v_status;
  end if;

  foreach v_emp in array coalesce(p_employee_numbers, array[]::text[]) loop
    v_sheet_id := null;
    insert into public.mission_sheets
      (template_id, employee_number, period, stage, issued_by_email)
    values
      (p_template_id, v_emp, v_period, 'issued', v_actor)
    on conflict (employee_number, period) do nothing
    returning id into v_sheet_id;

    if v_sheet_id is not null then
      insert into public.mission_stage_events
        (sheet_id, from_stage, to_stage, actor_email)
      values
        (v_sheet_id, null, 'issued', v_actor);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ── 8. RPC: mission_set_stage ───────────────────────────────────────
-- ステージを ±1 ステップだけ遷移させる（シート状態変更の唯一の経路）。
--   前進: issued→goal_submitted            = 本人のみ（自分のシート）
--         goal_submitted→goal_confirmed    = 評価者 or manage
--         goal_confirmed→mid_done          = 評価者 or manage
--         mid_done→final_submitted         = 評価者 or manage
--         final_submitted→assessed         = manage のみ
--   後退（1つ戻す）: 評価者 or manage のみ。p_reason 必須。
create or replace function public.mission_set_stage(
  p_sheet_id uuid,
  p_to_stage public.mission_stage,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order text[] := array
    ['issued','goal_submitted','goal_confirmed','mid_done','final_submitted','assessed'];
  v_employee_number text;
  v_from_stage public.mission_stage;
  v_from_idx integer;
  v_to_idx integer;
  v_manage boolean;
  v_evaluator boolean;
  v_self boolean;
  v_actor text := lower(coalesce(auth.email(), ''));
begin
  select s.employee_number, s.stage
    into v_employee_number, v_from_stage
  from public.mission_sheets s
  where s.id = p_sheet_id
  for update;
  if not found then
    raise exception 'mission_set_stage: sheet % not found', p_sheet_id;
  end if;

  v_from_idx := array_position(v_order, v_from_stage::text);
  v_to_idx   := array_position(v_order, p_to_stage::text);
  if v_from_idx is null or v_to_idx is null
    or abs(v_to_idx - v_from_idx) <> 1
  then
    raise exception 'mission_set_stage: invalid transition % -> % (only +/-1 step allowed)',
      v_from_stage, p_to_stage;
  end if;

  v_manage := public.can_manage_missions();
  v_evaluator := v_manage or public.is_mission_evaluator_of(v_employee_number);
  v_self := public.current_employee_number() is not null
    and v_employee_number = public.current_employee_number();

  if v_to_idx > v_from_idx then
    -- 前進
    if v_from_stage = 'issued' then
      -- issued → goal_submitted: 本人のみ
      if not v_self then
        raise exception 'mission_set_stage: only the sheet owner can submit (issued -> goal_submitted)';
      end if;
    elsif p_to_stage = 'assessed' then
      -- final_submitted → assessed: manage のみ
      if not v_manage then
        raise exception 'mission_set_stage: mission.manage required (final_submitted -> assessed)';
      end if;
    else
      -- goal_submitted→goal_confirmed / goal_confirmed→mid_done / mid_done→final_submitted
      if not v_evaluator then
        raise exception 'mission_set_stage: evaluator or mission.manage required (% -> %)',
          v_from_stage, p_to_stage;
      end if;
    end if;
  else
    -- 後退（差し戻し）: 評価者 or manage のみ・理由必須
    if not v_evaluator then
      raise exception 'mission_set_stage: evaluator or mission.manage required for rollback (% -> %)',
        v_from_stage, p_to_stage;
    end if;
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'mission_set_stage: reason is required for rollback';
    end if;
  end if;

  update public.mission_sheets
    set stage = p_to_stage
    where id = p_sheet_id;

  insert into public.mission_stage_events
    (sheet_id, from_stage, to_stage, actor_email, reason)
  values
    (p_sheet_id, v_from_stage, p_to_stage, v_actor, p_reason);
end;
$$;

-- ── 9. RLS ──────────────────────────────────────────────────────────
alter table public.mission_templates enable row level security;
alter table public.mission_sheets enable row level security;
alter table public.mission_answers enable row level security;
alter table public.mission_stage_events enable row level security;

-- mission_templates: 閲覧は authenticated 全員（自分のシートのテンプレ
-- 描画に必要）。書込みは can_manage_missions() のみ（＋不可変トリガ）。
drop policy if exists "mission_templates read (authenticated)" on public.mission_templates;
create policy "mission_templates read (authenticated)"
  on public.mission_templates for select
  to authenticated
  using (true);

drop policy if exists "mission_templates insert (manage)" on public.mission_templates;
create policy "mission_templates insert (manage)"
  on public.mission_templates for insert
  to authenticated
  with check (public.can_manage_missions());

drop policy if exists "mission_templates update (manage)" on public.mission_templates;
create policy "mission_templates update (manage)"
  on public.mission_templates for update
  to authenticated
  using (public.can_manage_missions())
  with check (public.can_manage_missions());

drop policy if exists "mission_templates delete (manage)" on public.mission_templates;
create policy "mission_templates delete (manage)"
  on public.mission_templates for delete
  to authenticated
  using (public.can_manage_missions());

-- mission_sheets: SELECT のみ（本人・評価者・manage）。
-- INSERT/UPDATE/DELETE ポリシーは意図的に作らない＝クライアント直書き
-- 全面禁止。書込みは SECURITY DEFINER RPC（issue/set_stage）経由のみ。
drop policy if exists "mission_sheets read (own or evaluator or manage)" on public.mission_sheets;
create policy "mission_sheets read (own or evaluator or manage)"
  on public.mission_sheets for select
  to authenticated
  using (public.can_view_mission_sheet(id));

-- mission_answers: 閲覧はシート閲覧権と同一。INSERT/UPDATE は
-- mission_can_write_answer AND author_email=auth.email()。DELETE 不可。
drop policy if exists "mission_answers read (sheet viewers)" on public.mission_answers;
create policy "mission_answers read (sheet viewers)"
  on public.mission_answers for select
  to authenticated
  using (public.can_view_mission_sheet(sheet_id));

drop policy if exists "mission_answers insert (writable question)" on public.mission_answers;
create policy "mission_answers insert (writable question)"
  on public.mission_answers for insert
  to authenticated
  with check (
    public.mission_can_write_answer(sheet_id, question_id, respondent_role)
    and lower(coalesce(author_email, '')) = lower(coalesce(auth.email(), ''))
  );

-- UPDATE の USING は「書ける資格者」のみで判定（author_email を含めない）
-- — 上長交代後も現評価者が旧評価者の行を引き継いで更新できるようにする。
-- WITH CHECK 側で author_email=auth.email() を維持し、更新後の行は必ず
-- 実記入者名義になる（実記入者の自動記録を保つ）。
drop policy if exists "mission_answers update (writable question)" on public.mission_answers;
create policy "mission_answers update (writable question)"
  on public.mission_answers for update
  to authenticated
  using (
    public.mission_can_write_answer(sheet_id, question_id, respondent_role)
  )
  with check (
    public.mission_can_write_answer(sheet_id, question_id, respondent_role)
    and lower(coalesce(author_email, '')) = lower(coalesce(auth.email(), ''))
  );

-- mission_stage_events: SELECT のみ（履歴表示用）。書込みポリシーなし
-- ＝ RPC（SECURITY DEFINER）内のみ。
drop policy if exists "mission_stage_events read (sheet viewers)" on public.mission_stage_events;
create policy "mission_stage_events read (sheet viewers)"
  on public.mission_stage_events for select
  to authenticated
  using (public.can_view_mission_sheet(sheet_id));

-- ── 10. GRANT（0017 方式: anon から revoke all・面を最小化） ──────────
revoke all on public.mission_templates from anon;
revoke all on public.mission_sheets from anon;
revoke all on public.mission_answers from anon;
revoke all on public.mission_stage_events from anon;

grant select, insert, update, delete on public.mission_templates to authenticated;
-- mission_sheets / mission_stage_events は SELECT のみ（DML GRANT を
-- 付与しない多層防御。書込みは RPC の SECURITY DEFINER が担う）。
revoke insert, update, delete on public.mission_sheets from authenticated;
grant select on public.mission_sheets to authenticated;
revoke insert, update, delete on public.mission_stage_events from authenticated;
grant select on public.mission_stage_events to authenticated;
-- mission_answers は DELETE 不可（ポリシー不在＋GRANT 不在の二重防御）。
revoke delete on public.mission_answers from authenticated;
grant select, insert, update on public.mission_answers to authenticated;

-- 関数 GRANT: default の PUBLIC EXECUTE を剥がし、authenticated（＋
-- service_role）へ明示付与。ヘルパーは RLS ポリシー評価で authenticated
-- から呼ばれるため EXECUTE が必要。anon からは全て遮断。
revoke all on function public.is_mission_evaluator_of(text) from public, anon;
revoke all on function public.can_manage_missions() from public, anon;
revoke all on function public.can_view_mission_sheet(uuid) from public, anon;
revoke all on function public.mission_can_write_answer(uuid, text, public.mission_respondent) from public, anon;
revoke all on function public.mission_issue_sheets(uuid, text[]) from public, anon;
revoke all on function public.mission_set_stage(uuid, public.mission_stage, text) from public, anon;

grant execute on function public.is_mission_evaluator_of(text) to authenticated, service_role;
grant execute on function public.can_manage_missions() to authenticated, service_role;
grant execute on function public.can_view_mission_sheet(uuid) to authenticated, service_role;
grant execute on function public.mission_can_write_answer(uuid, text, public.mission_respondent) to authenticated, service_role;
grant execute on function public.mission_issue_sheets(uuid, text[]) to authenticated, service_role;
grant execute on function public.mission_set_stage(uuid, public.mission_stage, text) to authenticated, service_role;

-- ── 11. module_permissions seed ─────────────────────────────────────
-- 運用で変更済みの値は上書きしない（on conflict do nothing）。
insert into public.module_permissions (module, action, min_level) values
  ('mission', 'manage',       90),
  ('mission', 'evaluate_any', 90)
on conflict (module, action) do nothing;

commit;
