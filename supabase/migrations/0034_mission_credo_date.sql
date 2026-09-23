-- 0034: ミッションシート P5① — 新設問型 credo_eval / date のサーバ側対応
--
-- クライアント（src/lib/mission.ts）に追加した2型のサーバミラー:
--   • date       … value = { date: 'YYYY-MM-DD' }
--   • credo_eval … value = { focus?: bool, goal_eval?: text, final_eval?: text }
--     CREDO 1項目=1設問（respondent=both・phase=goal）。期初評価(goal_eval)と
--     期末評価(final_eval)が本人/上長×期初/期末の4枠になる。評価スケールは
--     テンプレ definition の設問 scale（既定 ○△✕・2026-07-13 裕鵬さん確定）。
--
-- 変更点:
--   1. mission_answer_filled に date / credo_eval の記入済み判定を追加
--   2. mission_can_write_answer の mid_done 特例（kpi_goal のみ）を
--      credo_eval にも拡張（期末評価の入力窓。期初系は §3 で凍結）
--   3. credo_eval 期初系フィールド（focus / goal_eval）の凍結ガードトリガ
--      （0019 の mission_answers_kpi_guard と同型の多層防御）
--
-- ランク計算（calc_mission_rank_v1）は変更なし = credo_eval はスコア外
-- （kpi_goal のウエイト＋number 加点＋is_fundamental ✕判定のみが計算対象）。

begin;

-- ── 1. mission_answer_filled — date / credo_eval 追加 ────────────────
-- クライアント isAnswerFilled（mission.ts）と同一基準を維持すること。
-- credo_eval は期初評価(goal_eval)を「記入済み」基準にする（focus は選択制・
-- final_eval は期末窓のため required 検証対象にしない）。
create or replace function public.mission_answer_filled(
  p_type text,
  p_value jsonb
)
returns boolean
language sql
immutable
as $$
  select case
    when p_value is null then false
    when p_type = 'number' then nullif(p_value->>'number', '') is not null
    when p_type = 'kpi_goal' then
      btrim(coalesce(p_value->>'title', '')) <> ''
      or nullif(p_value->>'target_value', '') is not null
    when p_type = 'date' then btrim(coalesce(p_value->>'date', '')) <> ''
    when p_type = 'credo_eval' then btrim(coalesce(p_value->>'goal_eval', '')) <> ''
    else btrim(coalesce(p_value->>'text', '')) <> ''
  end
$$;

-- ── 2. mission_can_write_answer — mid_done 特例を credo_eval へ拡張 ──
-- 0019 との差分は phase=goal の mid_done 特例2箇所のみ:
--   (v_type = 'kpi_goal' ...) → (v_type in ('kpi_goal','credo_eval') ...)
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
  v_type text;
begin
  select s.employee_number, s.stage, s.template_id
    into v_employee_number, v_stage, v_template_id
  from public.mission_sheets s
  where s.id = p_sheet_id;
  if not found then
    return false;
  end if;

  if v_stage = 'assessed' then
    return false;
  end if;

  select t.definition into v_def
  from public.mission_templates t
  where t.id = v_template_id;
  if v_def is null then
    return false;
  end if;

  select q.value into v_q
  from jsonb_array_elements(coalesce(v_def->'sections', '[]'::jsonb)) as sec(value),
       jsonb_array_elements(coalesce(sec.value->'questions', '[]'::jsonb)) as q(value)
  where q.value->>'id' = p_question_id
  limit 1;
  if v_q is null then
    return false;
  end if;

  v_type := v_q->>'type';
  if v_type = 'heading' then
    return false;
  end if;

  v_phase := coalesce(v_q->>'phase', 'goal');
  v_respondent := coalesce(v_q->>'respondent', 'self');

  if p_role = 'self' then
    if v_respondent not in ('self', 'both') then
      return false;
    end if;
    if v_employee_number is distinct from public.current_employee_number()
      or public.current_employee_number() is null
    then
      return false;
    end if;
    return case v_phase
      when 'goal' then
        v_stage in ('issued', 'goal_submitted')
        -- M-5: kpi_goal の実績入力／credo_eval の期末評価入力
        -- （期初系フィールドはトリガでロック）
        or (v_type in ('kpi_goal', 'credo_eval') and v_stage = 'mid_done')
      when 'mid'   then v_stage = 'goal_confirmed'
      when 'final' then v_stage = 'mid_done'
      else false
    end;
  else
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
      when 'goal' then
        v_stage = 'goal_submitted'
        -- M-5: kpi_goal の達成度入力／credo_eval の期末評価入力
        -- （期初系フィールドはトリガでロック）
        or (v_type in ('kpi_goal', 'credo_eval') and v_stage = 'mid_done')
      when 'mid'   then v_stage = 'goal_confirmed'
      when 'final' then v_stage = 'mid_done'
      else false
    end;
  end if;
end;
$$;

-- ── 3. credo_eval 期初系フィールドの凍結ガード ───────────────────────
-- 期初確定（goal_confirmed）以降、credo_eval（phase=goal）の
--   • UPDATE: 期初系フィールド（focus / goal_eval）を変更不可
--   • INSERT: 期初系フィールドが空の行のみ許可（mid_done の入力窓で
--     期初評価入りの行を新規作成する迂回を塞ぐ。期末評価のみの行＝
--     通常の期末入力は通る）
-- mission_answers_kpi_guard（0019）と同型。トリガは別本にして責務を分離。
create or replace function public.mission_answers_credo_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage public.mission_stage;
  v_template_id uuid;
  v_q jsonb;
begin
  select s.stage, s.template_id into v_stage, v_template_id
  from public.mission_sheets s
  where s.id = NEW.sheet_id;
  if not found then
    return NEW;
  end if;

  -- 期初段階（issued / goal_submitted）は自由に編集可
  if v_stage in ('issued', 'goal_submitted') then
    return NEW;
  end if;

  select q.value into v_q
  from public.mission_templates t,
       jsonb_array_elements(coalesce(t.definition->'sections', '[]'::jsonb)) as sec(value),
       jsonb_array_elements(coalesce(sec.value->'questions', '[]'::jsonb)) as q(value)
  where t.id = v_template_id
    and q.value->>'id' = NEW.question_id
  limit 1;
  if v_q is null
    or v_q->>'type' <> 'credo_eval'
    or coalesce(v_q->>'phase', 'goal') <> 'goal'
  then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    if coalesce(NEW.value->>'goal_eval', '') <> ''
      or NEW.value->>'focus' is not null
    then
      raise exception '期初確定後はCREDOの期初評価・注力テーマは追加できません';
    end if;
    return NEW;
  end if;

  if coalesce(NEW.value->>'goal_eval', '') is distinct from coalesce(OLD.value->>'goal_eval', '')
    or NEW.value->>'focus' is distinct from OLD.value->>'focus'
  then
    raise exception '期初確定後はCREDOの期初評価・注力テーマは変更できません';
  end if;

  return NEW;
end;
$$;

drop trigger if exists mission_answers_credo_guard on public.mission_answers;
create trigger mission_answers_credo_guard
  before insert or update on public.mission_answers
  for each row execute function public.mission_answers_credo_guard();

-- ── 4. 権限（0018/0019 と同方針） ────────────────────────────────────
revoke all on function public.mission_answers_credo_guard() from public, anon;

commit;
