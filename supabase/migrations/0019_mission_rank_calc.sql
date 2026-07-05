-- ─────────────────────────────────────────────────────────────────────
-- 0019_mission_rank_calc
--
-- P2 第2弾: 中間・期末記入〜ランク計算〜査定確定。
--
-- ランク計算式は 4期下期の実運用 xlsx（mission.xlsx【成果】【査定】＋
-- 等級テーブル評価点設定シート）から照合済み（2026-07-05）:
--   • スコア = Σ(ウエイト × 達成度) + 加点（手入力点）。ウエイト合計=100想定
--   • 使うのは上長（evaluator）側の値のみ。自己評価は表示・面談用
--   • ランク閾値（下限含む・上限未満）:
--       D <71 / C 71-90 / B- 91-100 / B 101-110 / B+ 111-120 /
--       A 121-140 / A+ 141〜
--   • アタリマエ評価: ✕が1つでもあれば C 天井（合計71未満は D のまま）
--   • 賞与係数・昇給・昇格はレンジ内裁量（人が決める）→ 本関数のスコープ外。
--     salary_records への反映は payroll 管理者の手動オペ（自動書込しない）
--
-- 3層分離:
--   ロジック   = calc_mission_rank_v1()（本ファイル）
--   パラメータ = テンプレ definition JSONB（ウエイト・is_fundamental・
--                is_bonus・definition.calc.thresholds。未指定は xlsx 既定値）
--   確定値     = mission_sheets.computed_result / final_grade に凍結
--
-- Adds:
--   • calc_mission_rank_v1(uuid) — 純粋計算（書込みなし）。評価者/manage の
--     プレビュー RPC としても共用
--   • mission_assess(uuid, text) — manage 限定。final_submitted → assessed。
--     計算結果とランクをシートに凍結
--   • mission_required_missing(uuid, text) — ステージ遷移時のサーバ側
--     required 検証（設計負債: RPC 直叩きで未記入提出可 → 塞ぐ）
--   • mission_can_write_answer 改修（設計負債 M-5）: kpi_goal（phase=goal）
--     の実績・達成度を stage='mid_done' でも記入可能に
--   • mission_answers_kpi_guard トリガ — 期初確定後の kpi_goal 更新で
--     目標系フィールド（title/metric/target_value/unit）の改変を禁止
--   • mission_set_stage 改修 — required 検証・assessed への前進は
--     mission_assess 経由のみ・assessed からの差し戻しは manage 限定＋
--     凍結値クリア
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ── 1. required 検証ヘルパー ─────────────────────────────────────────
-- p_kind = 'goal_submit'  : 本人提出時（required な self/both × goal 設問）
-- p_kind = 'final_submit' : 期末提出時（required な final 設問＋ウエイト付
--                           kpi_goal の上長達成度）
-- 返り値 = 未記入の設問ラベル配列（空配列 = OK）。
-- 「記入済み」判定はクライアント isAnswerFilled と同一基準。
create or replace function public.mission_required_missing(
  p_sheet_id uuid,
  p_kind text
)
returns text[]
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_template_id uuid;
  v_def jsonb;
  v_q jsonb;
  v_type text;
  v_phase text;
  v_resp text;
  v_required boolean;
  v_weight numeric;
  v_missing text[] := array[]::text[];
  v_self_val jsonb;
  v_eval_val jsonb;
begin
  select s.template_id into v_template_id
  from public.mission_sheets s where s.id = p_sheet_id;
  if not found then return v_missing; end if;

  select t.definition into v_def
  from public.mission_templates t where t.id = v_template_id;
  if v_def is null then return v_missing; end if;

  for v_q in
    select q.value
    from jsonb_array_elements(coalesce(v_def->'sections', '[]'::jsonb)) as sec(value),
         jsonb_array_elements(coalesce(sec.value->'questions', '[]'::jsonb)) as q(value)
  loop
    v_type := v_q->>'type';
    if v_type = 'heading' then continue; end if;
    v_phase := coalesce(v_q->>'phase', 'goal');
    v_resp := coalesce(v_q->>'respondent', 'self');
    v_required := coalesce((v_q->>'required')::boolean, false);
    v_weight := coalesce(nullif(v_q->>'weight', '')::numeric, 0);

    select a.value into v_self_val
    from public.mission_answers a
    where a.sheet_id = p_sheet_id
      and a.question_id = v_q->>'id'
      and a.respondent_role = 'self';
    select a.value into v_eval_val
    from public.mission_answers a
    where a.sheet_id = p_sheet_id
      and a.question_id = v_q->>'id'
      and a.respondent_role = 'evaluator';

    if p_kind = 'goal_submit' then
      if v_required and v_phase = 'goal' and v_resp in ('self', 'both') then
        if not public.mission_answer_filled(v_type, v_self_val) then
          v_missing := v_missing || (v_q->>'label');
        end if;
      end if;

    elsif p_kind = 'final_submit' then
      if v_required and v_phase = 'final' then
        if v_resp in ('self', 'both')
          and not public.mission_answer_filled(v_type, v_self_val)
        then
          v_missing := v_missing || ((v_q->>'label') || '（本人）');
        end if;
        if v_resp in ('evaluator', 'both')
          and not public.mission_answer_filled(v_type, v_eval_val)
        then
          v_missing := v_missing || ((v_q->>'label') || '（上長）');
        end if;
      end if;
      -- ウエイト付き KPI は上長の達成度が査定計算の入力になるため必須
      if v_type = 'kpi_goal' and v_weight > 0 then
        if v_eval_val is null
          or nullif(v_eval_val->>'achievement_rate', '') is null
        then
          v_missing := v_missing || ((v_q->>'label') || '（上長の達成度）');
        end if;
      end if;
    end if;
  end loop;

  return v_missing;
end;
$$;

-- 記入済み判定（クライアント isAnswerFilled のサーバミラー）
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
    else btrim(coalesce(p_value->>'text', '')) <> ''
  end
$$;

-- ── 2. calc_mission_rank_v1 ─────────────────────────────────────────
-- 純粋計算（書込みなし）。評価者 or manage のみ実行可（本人には査定確定前
-- のランクを見せない）。テンプレの definition.calc.thresholds が無ければ
-- xlsx 既定の閾値表を使う。
--
-- 返り値 jsonb:
-- {
--   calc_version, weights_total,
--   mission_score, bonus_score, total,
--   fundamental_fail, fundamental_fails: [label],
--   missing_inputs: [label],        -- ウエイト付きKPIで上長達成度なし
--   fundamental_missing: [label],   -- アタリマエ項目で上長回答なし
--   rank_before_cap, rank,
--   items: [{question_id,label,weight,achievement_rate,score}],
--   bonus_items: [{question_id,label,points}]
-- }
create or replace function public.calc_mission_rank_v1(p_sheet_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_sheet record;
  v_def jsonb;
  v_thresholds jsonb;
  v_q jsonb;
  v_type text;
  v_weight numeric;
  v_is_bonus boolean;
  v_is_fundamental boolean;
  v_eval_val jsonb;
  v_rate numeric;
  v_score numeric;
  v_points numeric;
  v_txt text;
  v_weights_total numeric := 0;
  v_mission_score numeric := 0;
  v_bonus_score numeric := 0;
  v_total numeric;
  v_fundamental_fail boolean := false;
  v_fundamental_fails jsonb := '[]'::jsonb;
  v_fundamental_missing jsonb := '[]'::jsonb;
  v_missing jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_bonus_items jsonb := '[]'::jsonb;
  v_rank_raw text := null;
  v_rank text;
  v_t jsonb;
begin
  select s.id, s.employee_number, s.template_id into v_sheet
  from public.mission_sheets s where s.id = p_sheet_id;
  if not found then
    raise exception 'calc_mission_rank_v1: sheet % not found', p_sheet_id;
  end if;

  if not (
    public.is_mission_evaluator_of(v_sheet.employee_number)
    or public.can_manage_missions()
  ) then
    raise exception 'calc_mission_rank_v1: evaluator or mission.manage required';
  end if;

  select t.definition into v_def
  from public.mission_templates t where t.id = v_sheet.template_id;
  if v_def is null then
    raise exception 'calc_mission_rank_v1: template not found';
  end if;

  -- 閾値表（パラメータ層）: テンプレ指定が無ければ xlsx 既定値
  v_thresholds := coalesce(
    v_def->'calc'->'thresholds',
    '[{"grade":"A+","min":141},{"grade":"A","min":121},{"grade":"B+","min":111},
      {"grade":"B","min":101},{"grade":"B-","min":91},{"grade":"C","min":71},
      {"grade":"D","min":0}]'::jsonb
  );

  for v_q in
    select q.value
    from jsonb_array_elements(coalesce(v_def->'sections', '[]'::jsonb)) as sec(value),
         jsonb_array_elements(coalesce(sec.value->'questions', '[]'::jsonb)) as q(value)
  loop
    v_type := v_q->>'type';
    if v_type = 'heading' then continue; end if;
    v_weight := coalesce(nullif(v_q->>'weight', '')::numeric, 0);
    v_is_bonus := coalesce((v_q->>'is_bonus')::boolean, false);
    v_is_fundamental := coalesce((v_q->>'is_fundamental')::boolean, false);

    -- 計算に使うのは上長（evaluator）側の回答のみ（xlsx 準拠）
    select a.value into v_eval_val
    from public.mission_answers a
    where a.sheet_id = p_sheet_id
      and a.question_id = v_q->>'id'
      and a.respondent_role = 'evaluator';

    -- (a) ミッション評価: ウエイト × 達成度(%)/100
    if v_type = 'kpi_goal' and v_weight > 0 then
      v_weights_total := v_weights_total + v_weight;
      v_rate := nullif(coalesce(v_eval_val->>'achievement_rate', ''), '')::numeric;
      if v_rate is null then
        v_missing := v_missing || to_jsonb(v_q->>'label');
        v_score := 0;
      else
        v_score := round(v_weight * v_rate / 100.0, 2);
      end if;
      v_mission_score := v_mission_score + v_score;
      v_items := v_items || jsonb_build_object(
        'question_id', v_q->>'id',
        'label', v_q->>'label',
        'weight', v_weight,
        'achievement_rate', v_rate,
        'score', v_score
      );
    end if;

    -- (b) 加点評価: 手入力点をそのまま加算
    if v_type = 'number' and v_is_bonus then
      v_points := nullif(coalesce(v_eval_val->>'number', ''), '')::numeric;
      v_bonus_score := v_bonus_score + coalesce(v_points, 0);
      v_bonus_items := v_bonus_items || jsonb_build_object(
        'question_id', v_q->>'id',
        'label', v_q->>'label',
        'points', v_points
      );
    end if;

    -- (c) アタリマエ判定: ✕が1つでもあれば C 天井
    -- 「行なし」だけでなく空回答（一度選んで空に戻した {text:""}）も未回答扱い
    if v_is_fundamental then
      if v_eval_val is null
        or not public.mission_answer_filled(v_type, v_eval_val)
      then
        v_fundamental_missing := v_fundamental_missing || to_jsonb(v_q->>'label');
      else
        v_txt := btrim(coalesce(v_eval_val->>'text', ''));
        -- xlsx の COUNTIF は全角「×」のみだが表記揺れを正規化して拾う
        if v_txt in ('×', '✕', 'x', 'X', 'NG', 'ng') then
          v_fundamental_fail := true;
          v_fundamental_fails := v_fundamental_fails || to_jsonb(v_q->>'label');
        end if;
      end if;
    end if;
  end loop;

  v_total := round(v_mission_score + v_bonus_score, 2);

  -- 閾値表からランク決定（min の降順で最初に total >= min を満たす行）
  for v_t in
    select t.value
    from jsonb_array_elements(v_thresholds) as t(value)
    order by (t.value->>'min')::numeric desc
  loop
    if v_total >= (v_t->>'min')::numeric then
      v_rank_raw := v_t->>'grade';
      exit;
    end if;
  end loop;
  -- 全閾値を下回る場合は最下位グレード
  if v_rank_raw is null then
    select t.value->>'grade' into v_rank_raw
    from jsonb_array_elements(v_thresholds) as t(value)
    order by (t.value->>'min')::numeric asc
    limit 1;
  end if;

  -- アタリマエ✕ → C 天井（C/D はそのまま。xlsx の式順序と等価）
  v_rank := v_rank_raw;
  if v_fundamental_fail and v_rank_raw not in ('C', 'D') then
    v_rank := 'C';
  end if;

  return jsonb_build_object(
    'calc_version', 1,
    'weights_total', v_weights_total,
    'mission_score', round(v_mission_score, 2),
    'bonus_score', round(v_bonus_score, 2),
    'total', v_total,
    'fundamental_fail', v_fundamental_fail,
    'fundamental_fails', v_fundamental_fails,
    'fundamental_missing', v_fundamental_missing,
    'missing_inputs', v_missing,
    'rank_before_cap', v_rank_raw,
    'rank', v_rank,
    'items', v_items,
    'bonus_items', v_bonus_items
  );
end;
$$;

-- ── 3. mission_assess ───────────────────────────────────────────────
-- final_submitted → assessed の唯一の経路。manage 限定。
-- 計算結果とランクをシートに凍結する（確定値層）。入力不足
-- （上長達成度なし・アタリマエ未回答）があれば確定を拒否する。
create or replace function public.mission_assess(
  p_sheet_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage public.mission_stage;
  v_result jsonb;
  v_missing text;
  v_actor text := lower(coalesce(auth.email(), ''));
begin
  if not public.can_manage_missions() then
    raise exception 'mission_assess: permission denied (mission.manage required)';
  end if;

  select s.stage into v_stage
  from public.mission_sheets s
  where s.id = p_sheet_id
  for update;
  if not found then
    raise exception 'mission_assess: sheet % not found', p_sheet_id;
  end if;
  if v_stage <> 'final_submitted' then
    raise exception 'mission_assess: sheet must be final_submitted (stage=%)', v_stage;
  end if;

  v_result := public.calc_mission_rank_v1(p_sheet_id);

  -- 配点が1つも無いテンプレ（ウエイト未設定の旧 definition 等）での確定は
  -- ほぼ確実に全員 D 凍結の事故になるため拒否する
  if coalesce((v_result->>'weights_total')::numeric, 0) <= 0 then
    raise exception 'mission_assess: テンプレートにウエイト付きKPIがありません（ウエイト合計=%）。テンプレの配点を設定してから確定してください',
      coalesce(v_result->>'weights_total', '0');
  end if;

  if jsonb_array_length(v_result->'missing_inputs') > 0 then
    select string_agg(x #>> '{}', '、') into v_missing
    from jsonb_array_elements(v_result->'missing_inputs') as x;
    raise exception 'mission_assess: 上長の達成度が未入力のKPIがあります（%）', v_missing;
  end if;
  if jsonb_array_length(v_result->'fundamental_missing') > 0 then
    select string_agg(x #>> '{}', '、') into v_missing
    from jsonb_array_elements(v_result->'fundamental_missing') as x;
    raise exception 'mission_assess: アタリマエ評価が未入力です（%）', v_missing;
  end if;

  v_result := v_result || jsonb_build_object(
    'assessed_by', v_actor,
    'assessed_at', now()
  );

  update public.mission_sheets
    set stage = 'assessed',
        computed_result = v_result,
        final_grade = (v_result->>'rank')::public.evaluation_grade
    where id = p_sheet_id;

  insert into public.mission_stage_events
    (sheet_id, from_stage, to_stage, actor_email, reason)
  values
    (p_sheet_id, 'final_submitted', 'assessed', v_actor, p_reason);

  return v_result;
end;
$$;

-- ── 4. mission_can_write_answer 改修（設計負債 M-5） ─────────────────
-- 0018 との差分は kpi_goal（phase=goal）のみ:
--   self / evaluator とも stage='mid_done' でも書込み可（期末の実績値・
--   達成度の入力窓）。目標系フィールドの改変は §5 のトリガで禁止する。
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
        -- M-5: kpi_goal の実績入力（目標系はトリガでロック）
        or (v_type = 'kpi_goal' and v_stage = 'mid_done')
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
        -- M-5: kpi_goal の達成度入力（目標系はトリガでロック）
        or (v_type = 'kpi_goal' and v_stage = 'mid_done')
      when 'mid'   then v_stage = 'goal_confirmed'
      when 'final' then v_stage = 'mid_done'
      else false
    end;
  end if;
end;
$$;

-- ── 5. kpi_goal 目標フィールドの凍結ガード ───────────────────────────
-- 期初確定（goal_confirmed）以降、kpi_goal（phase=goal）の
--   • UPDATE: 目標系フィールド（title/metric/target_value/unit）を変更不可
--   • INSERT: 目標系フィールドが空の行のみ許可（期初に行を作らなかった
--     ケースで mid_done に目標入りの行を新規作成する迂回を塞ぐ。
--     達成度・実績のみの行＝evaluator の通常入力は通る）
-- mid_done で実績・達成度の書込みを開けたことに対する多層防御。
create or replace function public.mission_answers_kpi_guard()
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
    or v_q->>'type' <> 'kpi_goal'
    or coalesce(v_q->>'phase', 'goal') <> 'goal'
  then
    return NEW;
  end if;

  if TG_OP = 'INSERT' then
    if coalesce(NEW.value->>'title', '') <> ''
      or coalesce(NEW.value->>'metric', '') <> ''
      or NEW.value->>'target_value' is not null
      or coalesce(NEW.value->>'unit', '') <> ''
    then
      raise exception '期初確定後はKPIの目標項目（目標名・指標・目標値・単位）は追加できません';
    end if;
    return NEW;
  end if;

  if coalesce(NEW.value->>'title', '') is distinct from coalesce(OLD.value->>'title', '')
    or coalesce(NEW.value->>'metric', '') is distinct from coalesce(OLD.value->>'metric', '')
    or NEW.value->>'target_value' is distinct from OLD.value->>'target_value'
    or coalesce(NEW.value->>'unit', '') is distinct from coalesce(OLD.value->>'unit', '')
  then
    raise exception '期初確定後はKPIの目標項目（目標名・指標・目標値・単位）は変更できません';
  end if;

  return NEW;
end;
$$;

drop trigger if exists mission_answers_kpi_guard on public.mission_answers;
create trigger mission_answers_kpi_guard
  before insert or update on public.mission_answers
  for each row execute function public.mission_answers_kpi_guard();

-- ── 6. mission_set_stage 改修 ────────────────────────────────────────
-- 0018 との差分:
--   • issued→goal_submitted / mid_done→final_submitted でサーバ側
--     required 検証（RPC 直叩きの未記入提出を拒否）
--   • final_submitted→assessed の前進は禁止（mission_assess 経由のみ）
--   • assessed→final_submitted の差し戻しは manage 限定＋凍結値クリア
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
  v_missing text[];
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
      -- issued → goal_submitted: 本人のみ＋required 検証
      if not v_self then
        raise exception 'mission_set_stage: only the sheet owner can submit (issued -> goal_submitted)';
      end if;
      v_missing := public.mission_required_missing(p_sheet_id, 'goal_submit');
      if coalesce(array_length(v_missing, 1), 0) > 0 then
        raise exception '必須設問が未記入です（%）', array_to_string(v_missing, '、');
      end if;
    elsif p_to_stage = 'assessed' then
      -- 査定確定は計算・凍結を伴う mission_assess() 経由のみ
      raise exception 'mission_set_stage: use mission_assess() for final_submitted -> assessed';
    else
      -- goal_submitted→goal_confirmed / goal_confirmed→mid_done / mid_done→final_submitted
      if not v_evaluator then
        raise exception 'mission_set_stage: evaluator or mission.manage required (% -> %)',
          v_from_stage, p_to_stage;
      end if;
      if v_from_stage = 'mid_done' then
        v_missing := public.mission_required_missing(p_sheet_id, 'final_submit');
        if coalesce(array_length(v_missing, 1), 0) > 0 then
          raise exception '期末の必須項目が未記入です（%）', array_to_string(v_missing, '、');
        end if;
      end if;
    end if;
  else
    -- 後退（差し戻し）: 理由必須
    if p_reason is null or btrim(p_reason) = '' then
      raise exception 'mission_set_stage: reason is required for rollback';
    end if;
    if v_from_stage = 'assessed' then
      -- 査定確定の取り消しは manage 限定＋凍結値をクリア
      if not v_manage then
        raise exception 'mission_set_stage: mission.manage required for rollback from assessed';
      end if;
      update public.mission_sheets
        set computed_result = null, final_grade = null
        where id = p_sheet_id;
    elsif not v_evaluator then
      raise exception 'mission_set_stage: evaluator or mission.manage required for rollback (% -> %)',
        v_from_stage, p_to_stage;
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

-- ── 7. GRANT（0017/0018 方式） ───────────────────────────────────────
-- create or replace は既存関数の ACL を保持するため、既存4関数
-- （can_write_answer / set_stage）は 0018 の GRANT がそのまま生きる。
-- 新規関数のみ明示処理する。
revoke all on function public.mission_required_missing(uuid, text) from public, anon;
revoke all on function public.mission_answer_filled(text, jsonb) from public, anon;
revoke all on function public.calc_mission_rank_v1(uuid) from public, anon;
revoke all on function public.mission_assess(uuid, text) from public, anon;
revoke all on function public.mission_answers_kpi_guard() from public, anon;

-- mission_required_missing / mission_answer_filled は SECURITY DEFINER の
-- mission_set_stage / calc_mission_rank_v1 内（owner 権限）からのみ呼ばれる。
-- 内部に閲覧権チェックが無いため authenticated には EXECUTE を付与しない
-- （任意 sheet UUID での記入状況探りを防ぐ）。
grant execute on function public.mission_required_missing(uuid, text) to service_role;
grant execute on function public.mission_answer_filled(text, jsonb) to service_role;
grant execute on function public.calc_mission_rank_v1(uuid) to authenticated, service_role;
grant execute on function public.mission_assess(uuid, text) to authenticated, service_role;
-- トリガ関数は直接実行不要（trigger 起動はテーブル所有者権限）だが、
-- 念のため authenticated の EXECUTE は付与しない。

commit;
