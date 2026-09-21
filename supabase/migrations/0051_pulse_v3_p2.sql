-- ─────────────────────────────────────────────────────────────────────
-- 0051_pulse_v3_p2
--
-- パルスサーベイ v3 P2（アラート）のバックエンド一式。
-- 設計書: docs/PULSE_V3_DESIGN.md §10（この migration は §10-1〜§10-7・10-9 に対応）。
-- 決定5（人事管理者へ日次ダイジェスト・SOS/体調不安は即時・上長には通知しない・
-- 対応も人事）・決定1（上長に見せるアラートは仕事/健康/評価由来のみ）に従う。
--
-- 内容:
--   1. pulse_alert_rules 拡張（code/label/description/source/notify_immediately/
--      disclose_to_manager/sort_order）＋ 21ルール seed（8 score/behavior ＋
--      2 legacy(OFF) ＋ 11 comment）。type チェック制約は drop（type=code運用）
--   2. pulse_alerts 拡張（categories/disclose_to_manager/severity/notified_at/
--      notified_kind/updated_at）。type チェック制約も drop
--   3. 内部 pulse__evaluate_employee（本人×当サイクルの score/behavior/comment
--      全ルール判定・upsert/delete）／pulse_evaluate_cycle_rules（サイクル単位
--      ルール=preset_unanswered_3m）／pulse_evaluate_alerts 全面書き換え
--   4. pulse_comment_classifications 新設＋分類RPC（pending/apply）
--   5. pulse_alert_actions 拡張（title・state 5値）＋ open/closed 同期トリガ
--   6. 対応管理RPC（bulk_update/delete）／pulse_list_alerts 全面書き換え
--      （drop→create・列追加・own_unit は disclose_to_manager=true のみ）
--   7. 通知（pulse_settings 追加列・pulse_update_alert_notify_settings・
--      内部 pulse__request_classification/pulse__request_immediate・
--      pulse_alert_digest_batch・pulse_mark_alerts_notified・
--      pulse_cron_fire_alert_digest・cron登録 pulse-alert-digest 09:10 JST）
--   8. 振り返り・KPI RPC（pulse_alert_kpis／pulse_alert_review）
--   9. pulse_update_alert_rule（params のルール別バリデーション）
--
-- 契約の正: edge/frontend エージェントが並行実装済みの呼び出し側コード
-- （supabase/functions/pulse-comment-classify・pulse-alert-digest・
-- src/store/usePulseAlertsStore.ts・usePulseAdminStore.ts・usePulseDashStore.ts）
-- から RPC名・パラメータ名・返り値の形を実地確認して整合させている
-- （設計書のプローズだけでなく、実際に呼ばれる側のコードと一致させることを優先）。
--
-- pg_net を実発火させないための安全弁: 内部 pulse__request_classification /
-- pulse__request_immediate は current_setting('pulse.trial', true) = '1' の間は
-- 何もしない（supabase/tests/pulse_p2_trial.sql が `set local pulse.trial = '1'`
-- してから直接 pulse__evaluate_employee 等を呼ぶための保険。通常運用では未設定
-- のため無影響）。
--
-- 流儀は 0021〜0050 と同一（SECURITY DEFINER・set search_path = public・
-- revoke all ... from public, anon（必要に応じ authenticated も）・
-- 必要ロールにのみ grant execute・冪等）。1トランザクション。
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 10-1. pulse_alert_rules 拡張 ═══════════════════════════════════════
alter table public.pulse_alert_rules
  add column if not exists code text,
  add column if not exists label text,
  add column if not exists description text,
  add column if not exists source text not null default 'score'
    check (source in ('score','behavior','comment')),
  add column if not exists notify_immediately boolean not null default false,
  add column if not exists disclose_to_manager boolean not null default true,
  add column if not exists sort_order int not null default 0;

-- 既存の type チェック（absolute/delta/custom）を drop。以後 type は code と
-- 同じ文字列を入れる自由入力運用（新ルール追加のたびに制約を触らずに済む）。
alter table public.pulse_alert_rules drop constraint if exists pulse_alert_rules_type_check;

-- 既存 seed 2行（0021）に code を付与し is_active=false へ（name で特定）。
update public.pulse_alert_rules
  set code = 'legacy_absolute',
      type = 'legacy_absolute',
      label = '総合平均が低い（旧）',
      description = '天気4問の平均が閾値以下（旧・絶対値アラート）。',
      source = 'score',
      is_active = false,
      disclose_to_manager = true,
      sort_order = 9
  where name = '絶対値アラート（平均2以下）';

update public.pulse_alert_rules
  set code = 'legacy_delta',
      type = 'legacy_delta',
      label = '総合平均の急降下（旧）',
      description = '天気4問の平均が前回から急降下（旧・変化量アラート）。',
      source = 'score',
      is_active = false,
      disclose_to_manager = true,
      sort_order = 10
  where name = '変化量アラート（1.5以上の下落）';

-- code の一意制約（既存2行の backfill 後・新規19行 insert 前に追加）。
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pulse_alert_rules_code_key') then
    alter table public.pulse_alert_rules add constraint pulse_alert_rules_code_key unique (code);
  end if;
end $$;

-- 新規19ルール seed（code で冪等 upsert）。on conflict では表示用の列
-- （name/label/description/type/source/sort_order）だけを更新し、運用者が
-- pulse_update_alert_rule で変更し得る is_active/params/notify_immediately/
-- disclose_to_manager は re-run で巻き戻さない（0021 seed の「運用変更は
-- 上書きしない」を踏襲）。
insert into public.pulse_alert_rules
  (code, name, label, description, type, source, params, is_active, notify_immediately, disclose_to_manager, sort_order)
values
  ('geppo_stormy', '荒天がある', '荒天がある',
   '天気4問のいずれかが「荒天」以下。', 'geppo_stormy', 'score',
   '{"threshold":1}'::jsonb, true, false, true, 1),
  ('geppo_drop2', '2段階下落して雨以下', '2段階下落して雨以下',
   'いずれかの項目が前回比2段階以上下落し、今回「雨」以下。', 'geppo_drop2', 'score',
   '{"drop":2,"max_after":2}'::jsonb, true, false, true, 2),
  ('geppo_rain2', '雨以下が2項目', '雨以下が2項目',
   '「雨」以下の項目が2つ以上。', 'geppo_rain2', 'score',
   '{"threshold":2,"min_items":2}'::jsonb, true, false, true, 3),
  ('preset_all_cloudy', '全項目くもり', '全項目くもり',
   '天気4問すべてが「くもり」。', 'preset_all_cloudy', 'score',
   '{"score":3}'::jsonb, true, false, true, 4),
  ('preset_decline_3m', '3か月連続下降', '3か月連続下降',
   '直近3回答が暦月連続で、総合が単調減少。', 'preset_decline_3m', 'score',
   '{"months":3}'::jsonb, true, false, true, 5),
  ('preset_same_3m', '3か月同回答', '3か月同回答',
   '直近3回答が暦月連続で、天気4問が毎回同一。', 'preset_same_3m', 'behavior',
   '{"months":3}'::jsonb, true, false, false, 6),
  ('preset_org_change', '主務組織の変更', '主務組織の変更',
   '今回の主務部署が前回回答時と異なる。', 'preset_org_change', 'behavior',
   '{}'::jsonb, true, false, false, 7),
  ('preset_unanswered_3m', '3か月未回答', '3か月未回答',
   '当サイクル＋直前2サイクルすべて未回答（締切経過後に判定）。', 'preset_unanswered_3m', 'behavior',
   '{"months":3}'::jsonb, true, false, false, 8),
  ('comment_sos', 'SOS（自由記述）', 'SOS（自由記述）',
   '自由記述がSOSに分類された。', 'comment_sos', 'comment',
   '{"category":"SOS"}'::jsonb, true, true, false, 11),
  ('comment_health', '体調不安（自由記述）', '体調不安（自由記述）',
   '自由記述が体調不安に分類された。', 'comment_health', 'comment',
   '{"category":"体調不安"}'::jsonb, true, true, false, 12),
  ('comment_relationship', '人間関係（自由記述）', '人間関係（自由記述）',
   '自由記述が人間関係に分類された。', 'comment_relationship', 'comment',
   '{"category":"人間関係"}'::jsonb, true, false, false, 13),
  ('comment_org', '組織課題（自由記述）', '組織課題（自由記述）',
   '自由記述が組織課題に分類された。', 'comment_org', 'comment',
   '{"category":"組織課題"}'::jsonb, true, false, false, 14),
  ('comment_evaluation', '評価（自由記述）', '評価（自由記述）',
   '自由記述が評価に分類された。', 'comment_evaluation', 'comment',
   '{"category":"評価"}'::jsonb, true, false, false, 15),
  ('comment_work', '仕事（自由記述）', '仕事（自由記述）',
   '自由記述が仕事に分類された。', 'comment_work', 'comment',
   '{"category":"仕事"}'::jsonb, false, false, false, 16),
  ('comment_career', 'キャリア（自由記述）', 'キャリア（自由記述）',
   '自由記述がキャリアに分類された。', 'comment_career', 'comment',
   '{"category":"キャリア"}'::jsonb, false, false, false, 17),
  ('comment_private', 'プライベート（自由記述）', 'プライベート（自由記述）',
   '自由記述がプライベートに分類された。', 'comment_private', 'comment',
   '{"category":"プライベート"}'::jsonb, false, false, false, 18),
  ('comment_admin', '総務（自由記述）', '総務（自由記述）',
   '自由記述が総務に分類された。', 'comment_admin', 'comment',
   '{"category":"総務"}'::jsonb, false, false, false, 19),
  ('comment_request', '要望・提言（自由記述）', '要望・提言（自由記述）',
   '自由記述が要望/提言に分類された。', 'comment_request', 'comment',
   '{"category":"要望/提言"}'::jsonb, false, false, false, 20),
  ('comment_unclassified', '分類困難（自由記述）', '分類困難（自由記述）',
   '自由記述が分類困難に分類された。', 'comment_unclassified', 'comment',
   '{"category":"分類困難"}'::jsonb, false, false, false, 21)
on conflict (code) do update
  set name = excluded.name,
      label = excluded.label,
      description = excluded.description,
      type = excluded.type,
      source = excluded.source,
      sort_order = excluded.sort_order;

alter table public.pulse_alert_rules alter column code set not null;

-- ══ 10-2. pulse_alerts 拡張 ═════════════════════════════════════════════
alter table public.pulse_alerts
  add column if not exists categories text[] not null default '{}',
  add column if not exists disclose_to_manager boolean not null default false,
  add column if not exists severity text not null default 'warn'
    check (severity in ('info','warn','critical')),
  add column if not exists notified_at timestamptz,
  add column if not exists notified_kind text check (notified_kind in ('immediate','digest')),
  add column if not exists updated_at timestamptz not null default now();

alter table public.pulse_alerts drop constraint if exists pulse_alerts_type_check;

drop trigger if exists pulse_alerts_touch_updated_at on public.pulse_alerts;
create trigger pulse_alerts_touch_updated_at
  before update on public.pulse_alerts
  for each row execute function public.touch_updated_at();

-- ══ 10-4. pulse_comment_classifications 新設 ═══════════════════════════
create table if not exists public.pulse_comment_classifications (
  response_id uuid primary key references public.pulse_responses(id) on delete cascade,
  categories text[] not null default '{}',
  primary_category text,
  severity text check (severity in ('low','mid','high')),
  summary text,
  comment_hash text not null,
  model text,
  classified_at timestamptz not null default now(),
  error text
);

alter table public.pulse_comment_classifications enable row level security;

-- 「人事のみ」＝ admin か、can_manage_alert かつ scope='all'（全社）の保有者。
-- scope='own_unit'（上長）は can_manage_alert/realname を持っていても読めない
-- （決定1/5: コメント本文・その分類は上長に見せない。本番 rollback 試走 2026-09-21
-- で own_unit 上長が読めてしまう述語を検出して締めた）。
drop policy if exists "pulse_comment_classifications read (admin or hr realname+scope)"
  on public.pulse_comment_classifications;
drop policy if exists "pulse_comment_classifications read (admin or hr scope all)"
  on public.pulse_comment_classifications;
create policy "pulse_comment_classifications read (admin or hr scope all)"
  on public.pulse_comment_classifications for select to authenticated
  using (
    public.pulse_is_admin()
    or (public.pulse_can_manage_alert() and public.pulse_scope() = 'all')
  );

-- 書込ポリシーなし＝service_role 専有（RPC経由のみ）。
revoke all on public.pulse_comment_classifications from anon;
revoke insert, update, delete on public.pulse_comment_classifications from authenticated;
grant select on public.pulse_comment_classifications to authenticated;
grant all on public.pulse_comment_classifications to service_role;

-- ══ 10-5. pulse_alert_actions 拡張 ══════════════════════════════════════
alter table public.pulse_alert_actions
  add column if not exists title text;

alter table public.pulse_alert_actions drop constraint if exists pulse_alert_actions_state_check;
alter table public.pulse_alert_actions
  add constraint pulse_alert_actions_state_check
  check (state in ('todo','doing','done','not_needed','on_hold_org'));

-- 親アラートの open/closed 同期（insert/update/delete いずれでも）。
-- 行削除後は該当 alert_id の action が無くなる＝open に戻す。
-- 内部で public.pulse_alerts を直接 UPDATE する。0021 の RLS は authenticated に
-- pulse_alert_actions の直書き（insert/update）を許しているが pulse_alerts には
-- update ポリシーが無いため、非 DEFINER だと直書き経路では同期 UPDATE が RLS で
-- 黙って 0 行になる（旧バンドルの upsert が deploy 直後に走るケース）。
-- どの経路でも status が同期されるよう SECURITY DEFINER にする。
create or replace function public.pulse_alert_actions_sync_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert_id uuid := coalesce(new.alert_id, old.alert_id);
  v_state text;
  v_new_status text;
begin
  select state into v_state from public.pulse_alert_actions where alert_id = v_alert_id;
  v_new_status := case when v_state in ('done','not_needed') then 'closed' else 'open' end;
  update public.pulse_alerts set status = v_new_status where id = v_alert_id;
  return coalesce(new, old);
end;
$$;

drop trigger if exists pulse_alert_actions_sync_status on public.pulse_alert_actions;
create trigger pulse_alert_actions_sync_status
  after insert or update or delete on public.pulse_alert_actions
  for each row execute function public.pulse_alert_actions_sync_status();

-- ══ 10-6a. pulse_settings 追加列（通知先・ON/OFF） ══════════════════════
alter table public.pulse_settings
  add column if not exists alert_digest_recipients text[] not null default '{}',
  add column if not exists alert_digest_enabled boolean not null default true,
  add column if not exists alert_immediate_enabled boolean not null default true;

-- ══ 10-3. 内部 pulse__evaluate_employee（本人×当サイクルの全ルール判定） ══
-- score/behavior/comment の全 active ルールを判定し pulse_alerts を
-- upsert/delete する。呼び出しは pulse__submit_response / pulse_apply_classification /
-- pulse_evaluate_alerts のいずれも同一トランザクション内の SECURITY DEFINER
-- 経由のみ＝内部専用（public/anon/authenticated すべて revoke）。
create or replace function public.pulse__evaluate_employee(p_emp text, p_cycle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period text;
  v_response_id uuid;
  v_cur_dept text;
  v_comment text;
  v_cur jsonb;                     -- 当サイクルの天気4カテゴリ {category: score}

  v_prev_response_id uuid;
  v_prev_dept text;
  v_prev_period text;
  v_prev jsonb;                    -- 前回（直近の過去サイクル・暦月連続は問わない）

  v_rule public.pulse_alert_rules%rowtype;
  v_fired boolean;
  v_categories text[];
  v_reason jsonb;
  v_severity text;
  v_disclose boolean;
  v_alert_id uuid;
  v_is_new boolean;

  v_upserted int := 0;
  v_deleted int := 0;
  v_immediate_ids uuid[] := array[]::uuid[];
  v_del int;

  v_threshold numeric;
  v_drop numeric;
  v_max_after numeric;
  v_min_items int;
  v_cloudy_score numeric;
  v_months int;

  v_periods text[];
  v_overalls numeric[];
  v_catmaps jsonb[];
  v_ok boolean;
  i int;

  v_overall_cur numeric;
  v_overall_prev numeric;

  v_comment_categories text[];
  v_comment_summary text;
  v_comment_severity text;
begin
  select period into v_period from public.pulse_cycles where id = p_cycle_id;
  if v_period is null then
    return jsonb_build_object('upserted', 0, 'deleted', 0, 'immediate_alert_ids', '[]'::jsonb);
  end if;

  select id, snap_department, comment
    into v_response_id, v_cur_dept, v_comment
  from public.pulse_responses
  where employee_number = p_emp and cycle_id = p_cycle_id;

  if v_response_id is null then
    return jsonb_build_object('upserted', 0, 'deleted', 0, 'immediate_alert_ids', '[]'::jsonb);
  end if;

  select coalesce(jsonb_object_agg(q.category, a.score), '{}'::jsonb)
    into v_cur
  from public.pulse_answers a
  join public.pulse_questions q on q.id = a.question_id
  where a.response_id = v_response_id
    and a.score is not null
    and q.type = 'weather5'
    and q.category in ('仕事','対人','健康','評価');

  -- 前回（直近の過去サイクル・暦月連続は問わない）。
  select h.id, h.dept, h.period
    into v_prev_response_id, v_prev_dept, v_prev_period
  from (
    select r.id, r.snap_department as dept, c.period
    from public.pulse_responses r
    join public.pulse_cycles c on c.id = r.cycle_id
    where r.employee_number = p_emp
      and c.period < v_period
      and c.status in ('sent','closed')
    order by c.period desc
    limit 1
  ) h;

  select coalesce(jsonb_object_agg(q.category, a.score), '{}'::jsonb)
    into v_prev
  from public.pulse_answers a
  join public.pulse_questions q on q.id = a.question_id
  where a.response_id = v_prev_response_id
    and a.score is not null
    and q.type = 'weather5'
    and q.category in ('仕事','対人','健康','評価');

  -- ── geppo_stormy ──────────────────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'geppo_stormy';
  if v_rule.id is not null then
    v_threshold := coalesce((v_rule.params->>'threshold')::numeric, 1);
    select jsonb_agg(jsonb_build_object('category', e.key, 'score', (e.value)::numeric) order by e.key)
      into v_reason
    from jsonb_each_text(v_cur) e
    where (e.value)::numeric <= v_threshold;

    v_fired := v_rule.is_active and v_reason is not null and jsonb_array_length(v_reason) > 0;
    if v_fired then
      select coalesce(array_agg(e.key order by e.key), array[]::text[]) into v_categories
      from jsonb_each_text(v_cur) e where (e.value)::numeric <= v_threshold;
      v_severity := 'warn';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'geppo_stormy',
        jsonb_build_object('rule_code','geppo_stormy','rule',v_rule.label,'rule_id',v_rule.id,'items',v_reason),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'geppo_stormy'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── geppo_drop2 ───────────────────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'geppo_drop2';
  if v_rule.id is not null then
    v_drop := coalesce((v_rule.params->>'drop')::numeric, 2);
    v_max_after := coalesce((v_rule.params->>'max_after')::numeric, 2);
    select jsonb_agg(jsonb_build_object('category', d.k, 'prev', d.pv, 'cur', d.cv, 'prev_period', v_prev_period) order by d.k)
      into v_reason
    from (
      select pv.key as k, (pv.value)::numeric as pv, (cv.value)::numeric as cv
      from jsonb_each_text(v_prev) pv
      join jsonb_each_text(v_cur) cv on cv.key = pv.key
      where (pv.value)::numeric - (cv.value)::numeric >= v_drop
        and (cv.value)::numeric <= v_max_after
    ) d;

    v_fired := v_rule.is_active and v_reason is not null and jsonb_array_length(v_reason) > 0;
    if v_fired then
      select coalesce(array_agg(d.k order by d.k), array[]::text[]) into v_categories
      from (
        select pv.key as k
        from jsonb_each_text(v_prev) pv
        join jsonb_each_text(v_cur) cv on cv.key = pv.key
        where (pv.value)::numeric - (cv.value)::numeric >= v_drop
          and (cv.value)::numeric <= v_max_after
      ) d;
      v_severity := 'warn';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'geppo_drop2',
        jsonb_build_object('rule_code','geppo_drop2','rule',v_rule.label,'rule_id',v_rule.id,'items',v_reason),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'geppo_drop2'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── geppo_rain2 ───────────────────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'geppo_rain2';
  if v_rule.id is not null then
    v_threshold := coalesce((v_rule.params->>'threshold')::numeric, 2);
    v_min_items := coalesce((v_rule.params->>'min_items')::int, 2);
    select jsonb_agg(jsonb_build_object('category', e.key, 'score', (e.value)::numeric) order by e.key)
      into v_reason
    from jsonb_each_text(v_cur) e
    where (e.value)::numeric <= v_threshold;

    v_fired := v_rule.is_active and v_reason is not null and jsonb_array_length(v_reason) >= v_min_items;
    if v_fired then
      select coalesce(array_agg(e.key order by e.key), array[]::text[]) into v_categories
      from jsonb_each_text(v_cur) e where (e.value)::numeric <= v_threshold;
      v_severity := 'warn';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'geppo_rain2',
        jsonb_build_object('rule_code','geppo_rain2','rule',v_rule.label,'rule_id',v_rule.id,'items',v_reason),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'geppo_rain2'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── preset_all_cloudy ─────────────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'preset_all_cloudy';
  if v_rule.id is not null then
    v_cloudy_score := coalesce((v_rule.params->>'score')::numeric, 3);
    v_fired := v_rule.is_active
      and v_cur ?& array['仕事','対人','健康','評価']
      and (v_cur->>'仕事')::numeric = v_cloudy_score
      and (v_cur->>'対人')::numeric = v_cloudy_score
      and (v_cur->>'健康')::numeric = v_cloudy_score
      and (v_cur->>'評価')::numeric = v_cloudy_score;
    if v_fired then
      v_categories := array['仕事','対人','健康','評価'];
      v_severity := 'info';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'preset_all_cloudy',
        jsonb_build_object('rule_code','preset_all_cloudy','rule',v_rule.label,'rule_id',v_rule.id),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'preset_all_cloudy'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── preset_decline_3m（直近 months 回答・暦月連続・overall 単調減少） ──
  select * into v_rule from public.pulse_alert_rules where code = 'preset_decline_3m';
  if v_rule.id is not null then
    v_months := coalesce((v_rule.params->>'months')::int, 3);
    select array_agg(x.period order by x.period asc), array_agg(x.overall order by x.period asc)
      into v_periods, v_overalls
    from (
      select c.period,
        round(avg(a.score::numeric) filter (where a.score is not null and q.type in ('weather5','scale')), 3) as overall
      from public.pulse_responses r
      join public.pulse_cycles c on c.id = r.cycle_id
      join public.pulse_answers a on a.response_id = r.id
      join public.pulse_questions q on q.id = a.question_id
      where r.employee_number = p_emp
        and c.period <= v_period
        and c.status in ('sent','closed')
      group by c.period, r.id
      order by c.period desc
      limit v_months
    ) x;

    v_ok := coalesce(array_length(v_periods, 1), 0) = v_months;
    if v_ok then
      for i in 1..v_months - 1 loop
        if to_date(v_periods[i+1]||'-01','YYYY-MM-DD') <> to_date(v_periods[i]||'-01','YYYY-MM-DD') + interval '1 month'
        then v_ok := false; exit; end if;
        if v_overalls[i] is null or v_overalls[i+1] is null or v_overalls[i+1] >= v_overalls[i] then
          v_ok := false; exit;
        end if;
      end loop;
    end if;

    v_fired := v_rule.is_active and v_ok;
    if v_fired then
      select jsonb_agg(jsonb_build_object('period', v_periods[k], 'overall', v_overalls[k]) order by k)
        into v_reason
      from generate_series(1, v_months) as k;
      v_categories := array['仕事','対人','健康','評価'];
      v_severity := 'warn';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'preset_decline_3m',
        jsonb_build_object('rule_code','preset_decline_3m','rule',v_rule.label,'rule_id',v_rule.id,'series',v_reason),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'preset_decline_3m'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── preset_same_3m（直近 months 回答・暦月連続・天気4問が毎回同一） ──
  select * into v_rule from public.pulse_alert_rules where code = 'preset_same_3m';
  if v_rule.id is not null then
    v_months := coalesce((v_rule.params->>'months')::int, 3);
    select array_agg(x.period order by x.period asc), array_agg(x.cat_map order by x.period asc)
      into v_periods, v_catmaps
    from (
      select c.period,
        coalesce(jsonb_object_agg(q.category, a.score) filter (
          where a.score is not null and q.type = 'weather5' and q.category in ('仕事','対人','健康','評価')
        ), '{}'::jsonb) as cat_map
      from public.pulse_responses r
      join public.pulse_cycles c on c.id = r.cycle_id
      join public.pulse_answers a on a.response_id = r.id
      join public.pulse_questions q on q.id = a.question_id
      where r.employee_number = p_emp
        and c.period <= v_period
        and c.status in ('sent','closed')
      group by c.period, r.id
      order by c.period desc
      limit v_months
    ) x;

    v_ok := coalesce(array_length(v_periods, 1), 0) = v_months
      and v_catmaps[1] ?& array['仕事','対人','健康','評価'];
    if v_ok then
      for i in 1..v_months - 1 loop
        if to_date(v_periods[i+1]||'-01','YYYY-MM-DD') <> to_date(v_periods[i]||'-01','YYYY-MM-DD') + interval '1 month'
        then v_ok := false; exit; end if;
        if v_catmaps[i+1] <> v_catmaps[1] then v_ok := false; exit; end if;
      end loop;
    end if;

    v_fired := v_rule.is_active and v_ok;
    if v_fired then
      v_categories := array[]::text[];
      v_severity := 'info';
      v_disclose := false; -- behavior 系は常に非開示
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'preset_same_3m',
        jsonb_build_object('rule_code','preset_same_3m','rule',v_rule.label,'rule_id',v_rule.id,
          'periods', to_jsonb(v_periods), 'scores', v_catmaps[1]),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'preset_same_3m'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── preset_org_change ─────────────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'preset_org_change';
  if v_rule.id is not null then
    v_fired := v_rule.is_active
      and v_prev_dept is not null and btrim(v_prev_dept) <> ''
      and v_cur_dept is not null and btrim(v_cur_dept) <> ''
      and v_prev_dept <> v_cur_dept;
    if v_fired then
      v_categories := array[]::text[];
      v_severity := 'info';
      v_disclose := false;
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'preset_org_change',
        jsonb_build_object('rule_code','preset_org_change','rule',v_rule.label,'rule_id',v_rule.id,
          'prev_department', v_prev_dept, 'department', v_cur_dept, 'prev_period', v_prev_period),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'preset_org_change'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── legacy_absolute（OFF既定・admin再有効化時のみ判定対象） ──────────
  select * into v_rule from public.pulse_alert_rules where code = 'legacy_absolute';
  if v_rule.id is not null then
    v_threshold := coalesce((v_rule.params->>'threshold')::numeric, 2);
    select avg(a.score::numeric) filter (where a.score is not null and q.type in ('weather5','scale'))
      into v_overall_cur
    from public.pulse_answers a join public.pulse_questions q on q.id = a.question_id
    where a.response_id = v_response_id;

    v_fired := v_rule.is_active and v_overall_cur is not null and v_overall_cur <= v_threshold;
    if v_fired then
      v_categories := array['仕事','対人','健康','評価'];
      v_severity := 'info';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'legacy_absolute',
        jsonb_build_object('rule_code','legacy_absolute','rule',v_rule.label,'rule_id',v_rule.id,
          'overall', round(v_overall_cur,3), 'threshold', v_threshold),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'legacy_absolute'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── legacy_delta（OFF既定） ───────────────────────────────────────
  select * into v_rule from public.pulse_alert_rules where code = 'legacy_delta';
  if v_rule.id is not null then
    v_drop := coalesce((v_rule.params->>'drop')::numeric, 1.5);
    select avg(a.score::numeric) filter (where a.score is not null and q.type in ('weather5','scale'))
      into v_overall_cur
    from public.pulse_answers a join public.pulse_questions q on q.id = a.question_id
    where a.response_id = v_response_id;
    select avg(a.score::numeric) filter (where a.score is not null and q.type in ('weather5','scale'))
      into v_overall_prev
    from public.pulse_answers a join public.pulse_questions q on q.id = a.question_id
    where a.response_id = v_prev_response_id;

    v_fired := v_rule.is_active and v_overall_cur is not null and v_overall_prev is not null
      and (v_overall_prev - v_overall_cur) >= v_drop;
    if v_fired then
      v_categories := array['仕事','対人','健康','評価'];
      v_severity := 'info';
      v_disclose := coalesce(v_rule.disclose_to_manager, true) and v_rule.source = 'score'
        and v_categories <@ array['仕事','健康','評価'];
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, 'legacy_delta',
        jsonb_build_object('rule_code','legacy_delta','rule',v_rule.label,'rule_id',v_rule.id,
          'overall', round(v_overall_cur,3), 'prev_overall', round(v_overall_prev,3),
          'delta', round(v_overall_cur - v_overall_prev,3), 'drop_threshold', v_drop),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    else
      delete from public.pulse_alerts al
      where al.employee_number = p_emp and al.cycle_id = p_cycle_id and al.type = 'legacy_delta'
        and al.notified_at is null
        and not exists (select 1 from public.pulse_alert_actions ac where ac.alert_id = al.id);
      get diagnostics v_del = row_count;
      v_deleted := v_deleted + v_del;
    end if;
  end if;

  -- ── comment_*（分類が既にあれば全 active ルールと突合。無ければ skip。
  --     comment 由来は「分類が更新されるまで残す」＝条件を満たさなくなっても
  --     delete しない） ──────────────────────────────────────────────
  select categories, summary, severity
    into v_comment_categories, v_comment_summary, v_comment_severity
  from public.pulse_comment_classifications
  where response_id = v_response_id;

  if v_comment_categories is not null then
    for v_rule in
      select * from public.pulse_alert_rules
      where is_active and source = 'comment'
        and (params->>'category') = any(v_comment_categories)
    loop
      v_categories := array[coalesce(v_rule.params->>'category','')];
      v_severity := case when v_rule.code in ('comment_sos','comment_health') then 'critical' else 'info' end;
      v_disclose := false; -- comment 系は常に非開示
      insert into public.pulse_alerts
        (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
      values (p_emp, p_cycle_id, v_rule.code,
        jsonb_build_object('rule_code', v_rule.code, 'rule', v_rule.label, 'rule_id', v_rule.id,
          'category', v_rule.params->>'category', 'summary', v_comment_summary, 'severity', v_comment_severity),
        v_categories, v_severity, v_disclose, 'open')
      on conflict (employee_number, cycle_id, type) do update
        set reason = excluded.reason, categories = excluded.categories, severity = excluded.severity,
            disclose_to_manager = excluded.disclose_to_manager, status = 'open', updated_at = now()
      returning id, (xmax = 0) into v_alert_id, v_is_new;
      v_upserted := v_upserted + 1;
      if v_is_new and v_rule.notify_immediately then
        v_immediate_ids := v_immediate_ids || v_alert_id;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'upserted', v_upserted,
    'deleted', v_deleted,
    'immediate_alert_ids', to_jsonb(v_immediate_ids)
  );
end;
$$;

revoke all on function public.pulse__evaluate_employee(text, uuid) from public, anon, authenticated, service_role;

-- ══ 10-3b. pulse_evaluate_cycle_rules（サイクル単位ルール=preset_unanswered_3m） ══
-- service_role 専用（日次ダイジェストから）＋ pulse_evaluate_alerts から内部呼び出し。
-- 「period 連続」は暦月演算で当サイクルから遡って求める（テーブル行の並びではなく
-- 実際の月差で判定＝他の未来/過去サイクルの混入を防ぐ）。
create or replace function public.pulse_evaluate_cycle_rules(p_cycle_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cycle public.pulse_cycles%rowtype;
  v_rule public.pulse_alert_rules%rowtype;
  v_months int;
  v_periods text[] := array[]::text[];
  v_cycle_ids uuid[];
  v_ok boolean;
  v_count int := 0;
  v_emp record;
  i int;
begin
  select * into v_cycle from public.pulse_cycles where id = p_cycle_id;
  if v_cycle.id is null then
    return 0;
  end if;

  select * into v_rule from public.pulse_alert_rules where code = 'preset_unanswered_3m';
  if v_rule.id is null or not v_rule.is_active then
    return 0;
  end if;

  if not (v_cycle.status = 'closed' or (v_cycle.due_date is not null and v_cycle.due_date < current_date)) then
    return 0;
  end if;

  v_months := coalesce((v_rule.params->>'months')::int, 3);

  for i in reverse (v_months - 1)..0 loop
    v_periods := v_periods || to_char(
      to_date(v_cycle.period||'-01','YYYY-MM-DD') - (i || ' months')::interval, 'YYYY-MM');
  end loop;

  select (count(*) = v_months) and bool_and(c.status in ('sent','closed')), array_agg(c.id)
    into v_ok, v_cycle_ids
  from public.pulse_cycles c
  where c.period = any(v_periods);

  if not coalesce(v_ok, false) then
    return 0;
  end if;

  for v_emp in
    select e.employee_number
    from public.employees e
    where e.left_at is null
      and public.pulse_is_target(e.employee_number)
      and not exists (
        select 1 from public.pulse_responses r
        where r.employee_number = e.employee_number and r.cycle_id = any(v_cycle_ids)
      )
  loop
    insert into public.pulse_alerts
      (employee_number, cycle_id, type, reason, categories, severity, disclose_to_manager, status)
    values (v_emp.employee_number, p_cycle_id, 'preset_unanswered_3m',
      jsonb_build_object('rule_code','preset_unanswered_3m','rule',v_rule.label,'rule_id',v_rule.id,
        'periods', to_jsonb(v_periods)),
      array[]::text[], 'info', false, 'open')
    on conflict (employee_number, cycle_id, type) do update
      set reason = excluded.reason, status = 'open', updated_at = now();
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.pulse_evaluate_cycle_rules(uuid) from public, anon, authenticated;
grant execute on function public.pulse_evaluate_cycle_rules(uuid) to service_role;

-- ══ 10-3c. pulse_evaluate_alerts 全面書き換え（既存シグネチャ・権限は維持） ══
-- 当サイクル回答者全員に pulse__evaluate_employee ＋ サイクル単位ルール。
-- 旧 absolute/delta 専用ループは廃止（legacy_* も pulse__evaluate_employee 内で
-- 判定される。既定 is_active=false のため通常は何も upsert しない）。
create or replace function public.pulse_evaluate_alerts(p_cycle_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_emp record;
  v_result jsonb;
begin
  if not (public.pulse_is_admin() or public.pulse_can_manage_alert()) then
    raise exception 'pulse_evaluate_alerts: permission denied';
  end if;

  if not exists (select 1 from public.pulse_cycles where id = p_cycle_id) then
    raise exception 'pulse_evaluate_alerts: cycle % not found', p_cycle_id;
  end if;

  for v_emp in
    select distinct employee_number from public.pulse_responses where cycle_id = p_cycle_id
  loop
    v_result := public.pulse__evaluate_employee(v_emp.employee_number, p_cycle_id);
    v_count := v_count + coalesce((v_result->>'upserted')::int, 0);
  end loop;

  v_count := v_count + public.pulse_evaluate_cycle_rules(p_cycle_id);

  return v_count;
end;
$$;

-- (既存 grant は 0021 でこのシグネチャへ既に付与済み・不変のため再掲不要)

-- ══ 10-6b. 内部 pulse__request_classification / pulse__request_immediate ══
-- pg_net で Edge Function を叩くだけの薄い内部関数（0050 と同じ Vault の読み方・
-- URL定数・timeout）。current_setting('pulse.trial', true)='1' の間は no-op
-- （supabase/tests/pulse_p2_trial.sql が `set local pulse.trial='1'` して安全に
-- 直接判定ロジックだけを検証できるようにするための保険）。
create or replace function public.pulse__request_classification(p_response_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_anon text;
  v_headers jsonb;
begin
  if coalesce(current_setting('pulse.trial', true), '') = '1' then
    return;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'pulse_cron_secret' limit 1;
  if v_secret is null or btrim(v_secret) = '' then
    return;
  end if;

  select decrypted_secret into v_anon
  from vault.decrypted_secrets where name = 'pulse_anon_key' limit 1;

  v_headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret);
  if v_anon is not null and btrim(v_anon) <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || btrim(v_anon));
  end if;

  perform net.http_post(
    url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-comment-classify',
    headers := v_headers,
    body := jsonb_build_object('response_id', p_response_id::text),
    timeout_milliseconds := 60000
  );
end;
$$;

create or replace function public.pulse__request_immediate(p_alert_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_anon text;
  v_headers jsonb;
begin
  if coalesce(current_setting('pulse.trial', true), '') = '1' then
    return;
  end if;
  if p_alert_ids is null or array_length(p_alert_ids, 1) is null then
    return;
  end if;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'pulse_cron_secret' limit 1;
  if v_secret is null or btrim(v_secret) = '' then
    return;
  end if;

  select decrypted_secret into v_anon
  from vault.decrypted_secrets where name = 'pulse_anon_key' limit 1;

  v_headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret);
  if v_anon is not null and btrim(v_anon) <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || btrim(v_anon));
  end if;

  perform net.http_post(
    url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-alert-digest',
    headers := v_headers,
    body := jsonb_build_object('mode', 'immediate', 'alert_ids', to_jsonb(p_alert_ids)),
    timeout_milliseconds := 60000
  );
end;
$$;

revoke all on function public.pulse__request_classification(uuid) from public, anon, authenticated, service_role;
revoke all on function public.pulse__request_immediate(uuid[]) from public, anon, authenticated, service_role;

-- ══ 10-3d/10-6c. pulse__submit_response 再定義（0049版 + 末尾に判定・通知要求を追加） ══
-- 0049 の本体をそのままコピーし、answers 挿入後（return の直前）に
-- pulse__evaluate_employee ＋ 条件付きで pulse__request_immediate /
-- pulse__request_classification を呼ぶ。いずれも例外を握って回答保存を
-- 失敗させない（begin ... exception when others then null; end;）。
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
  v_eval jsonb;
  v_immediate_ids uuid[];
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

  -- ── P2: 判定 ＋ 通知要求（失敗しても回答保存は失敗させない） ──────────
  begin
    v_eval := public.pulse__evaluate_employee(p_emp, p_cycle_id);

    if v_eval is not null and jsonb_array_length(coalesce(v_eval->'immediate_alert_ids', '[]'::jsonb)) > 0 then
      select array_agg(x::uuid) into v_immediate_ids
      from jsonb_array_elements_text(v_eval->'immediate_alert_ids') x;
      perform public.pulse__request_immediate(v_immediate_ids);
    end if;

    if p_comment is not null and btrim(p_comment) <> '' then
      perform public.pulse__request_classification(v_response_id);
    end if;
  exception when others then
    null;
  end;

  return v_response_id;
end;
$$;

revoke all on function public.pulse__submit_response(text, uuid, jsonb, text) from public, anon, authenticated, service_role;

-- ══ 10-4b. コメント分類 RPC（service_role 専用・識別子を返さない） ═══════
create or replace function public.pulse_pending_classifications(p_limit int default 50)
returns table (response_id uuid, comment text, weather jsonb, nps int)
language sql
security definer
set search_path = public
stable
as $$
  select
    r.id,
    r.comment,
    coalesce((
      select jsonb_object_agg(q.category, a.score)
      from public.pulse_answers a
      join public.pulse_questions q on q.id = a.question_id
      where a.response_id = r.id and a.score is not null
        and q.type = 'weather5' and q.category in ('仕事','対人','健康','評価')
    ), '{}'::jsonb),
    (
      select a2.score
      from public.pulse_answers a2
      join public.pulse_questions q2 on q2.id = a2.question_id
      where a2.response_id = r.id and q2.type = 'nps' and a2.score is not null
      limit 1
    )
  from public.pulse_responses r
  left join public.pulse_comment_classifications pc on pc.response_id = r.id
  where r.comment is not null and btrim(r.comment) <> ''
    and (pc.response_id is null or pc.comment_hash <> md5(r.comment))
  order by r.answered_at asc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;

revoke all on function public.pulse_pending_classifications(int) from public, anon, authenticated;
grant execute on function public.pulse_pending_classifications(int) to service_role;

create or replace function public.pulse_apply_classification(
  p_response_id uuid,
  p_categories text[],
  p_primary text,
  p_severity text,
  p_summary text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_comment text;
  v_emp text;
  v_cycle_id uuid;
  v_eval jsonb;
  v_immediate_ids uuid[];
begin
  select comment, employee_number, cycle_id
    into v_comment, v_emp, v_cycle_id
  from public.pulse_responses where id = p_response_id;
  if not found then
    raise exception 'pulse_apply_classification: response % not found', p_response_id;
  end if;

  insert into public.pulse_comment_classifications
    (response_id, categories, primary_category, severity, summary, comment_hash, model, classified_at, error)
  values
    (p_response_id, coalesce(p_categories, '{}'::text[]), p_primary, p_severity, p_summary,
     md5(coalesce(v_comment, '')), p_model, now(), null)
  on conflict (response_id) do update
    set categories = excluded.categories,
        primary_category = excluded.primary_category,
        severity = excluded.severity,
        summary = excluded.summary,
        comment_hash = excluded.comment_hash,
        model = excluded.model,
        classified_at = now(),
        error = null;

  v_eval := public.pulse__evaluate_employee(v_emp, v_cycle_id);

  if v_eval is not null and jsonb_array_length(coalesce(v_eval->'immediate_alert_ids', '[]'::jsonb)) > 0 then
    begin
      select array_agg(x::uuid) into v_immediate_ids
      from jsonb_array_elements_text(v_eval->'immediate_alert_ids') x;
      perform public.pulse__request_immediate(v_immediate_ids);
    exception when others then null;
    end;
  end if;

  return jsonb_build_object(
    'alerts_upserted', coalesce((v_eval->>'upserted')::int, 0),
    'immediate_alert_ids', coalesce(v_eval->'immediate_alert_ids', '[]'::jsonb)
  );
end;
$$;

revoke all on function public.pulse_apply_classification(uuid, text[], text, text, text, text) from public, anon, authenticated;
grant execute on function public.pulse_apply_classification(uuid, text[], text, text, text, text) to service_role;

-- ══ 10-5b. 対応管理 RPC ═════════════════════════════════════════════════
create or replace function public.pulse_bulk_update_alert_actions(p_alert_ids uuid[], p_patch jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int := 0;
  v_alert_id uuid;
  v_emp text;
begin
  if p_alert_ids is null or array_length(p_alert_ids, 1) is null then
    raise exception 'pulse_bulk_update_alert_actions: no alert ids given';
  end if;
  if array_length(p_alert_ids, 1) > 50 then
    raise exception 'pulse_bulk_update_alert_actions: at most 50 alerts per call';
  end if;
  if (p_patch ? 'state') and not (p_patch->>'state' in ('todo','doing','done','not_needed','on_hold_org')) then
    raise exception 'pulse_bulk_update_alert_actions: invalid state %', p_patch->>'state';
  end if;

  foreach v_alert_id in array p_alert_ids loop
    select employee_number into v_emp from public.pulse_alerts where id = v_alert_id;
    if v_emp is null then
      continue;
    end if;
    if not (public.pulse_can_manage_alert() and public.pulse_can_view_employee(v_emp)) then
      raise exception 'pulse_bulk_update_alert_actions: permission denied for alert %', v_alert_id;
    end if;

    insert into public.pulse_alert_actions as pa
      (alert_id, title, assignee_employee_number, state, due_date, note)
    values (
      v_alert_id,
      p_patch->>'title',
      p_patch->>'assignee_employee_number',
      coalesce(p_patch->>'state', 'todo'),
      nullif(p_patch->>'due_date', '')::date,
      p_patch->>'note'
    )
    on conflict (alert_id) do update set
      title = case when p_patch ? 'title' then excluded.title else pa.title end,
      assignee_employee_number = case when p_patch ? 'assignee_employee_number'
        then excluded.assignee_employee_number else pa.assignee_employee_number end,
      state = case when p_patch ? 'state' then excluded.state else pa.state end,
      due_date = case when p_patch ? 'due_date' then excluded.due_date else pa.due_date end,
      note = case when p_patch ? 'note' then excluded.note else pa.note end,
      updated_at = now();

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

revoke all on function public.pulse_bulk_update_alert_actions(uuid[], jsonb) from public, anon;
grant execute on function public.pulse_bulk_update_alert_actions(uuid[], jsonb) to authenticated, service_role;

create or replace function public.pulse_delete_alert_action(p_alert_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp text;
begin
  select employee_number into v_emp from public.pulse_alerts where id = p_alert_id;
  if v_emp is null then
    raise exception 'pulse_delete_alert_action: alert % not found', p_alert_id;
  end if;
  if not (public.pulse_can_manage_alert() and public.pulse_can_view_employee(v_emp)) then
    raise exception 'pulse_delete_alert_action: permission denied';
  end if;
  delete from public.pulse_alert_actions where alert_id = p_alert_id;
end;
$$;

revoke all on function public.pulse_delete_alert_action(uuid) from public, anon;
grant execute on function public.pulse_delete_alert_action(uuid) to authenticated, service_role;

-- pulse_set_alert_status は互換で残す（0024・UIからは使わない）。

-- ══ 10-5c. pulse_list_alerts 全面書き換え（返り値変更のため drop→create） ══
drop function if exists public.pulse_list_alerts(uuid);

create function public.pulse_list_alerts(p_cycle_id uuid)
returns table (
  alert_id uuid,
  employee_number text,
  subject_name text,
  subject_department text,
  type text,
  reason jsonb,
  status text,
  created_at timestamptz,
  period text,
  rule_code text,
  rule_label text,
  source text,
  categories text[],
  severity text,
  disclose_to_manager boolean,
  notified_at timestamptz,
  comment_categories text[],
  comment_summary text,
  sum_score integer,
  prev_sum_score integer,
  action jsonb
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_realname boolean := public.pulse_can_view_realname();
  v_scope text := public.pulse_scope();
begin
  if not public.pulse_can_manage_alert() then
    raise exception 'pulse_list_alerts: permission denied';
  end if;

  return query
  select
    al.id,
    al.employee_number,
    case when v_realname then coalesce(e.display_name, e.full_name, al.employee_number) else null end,
    e.department,
    al.type,
    al.reason,
    al.status,
    al.created_at,
    c.period,
    al.type,
    coalesce(ar.label, al.type),
    coalesce(ar.source, 'score'),
    al.categories,
    al.severity,
    al.disclose_to_manager,
    al.notified_at,
    -- 分類・要約は人事（admin/scope=all）のみ。上長（own_unit）には出さない（決定1/5）
    case when v_scope = 'all' then cc.categories else null end,
    case when v_scope = 'all' then cc.summary else null end,
    ss.sum_score::integer,
    ps.sum_score::integer,
    case when ac.id is null then null else jsonb_build_object(
      'id', ac.id,
      'title', ac.title,
      'assignee_employee_number', ac.assignee_employee_number,
      'assignee_name', case when ase.employee_number is null then null
        else coalesce(ase.display_name, ase.full_name, ase.employee_number) end,
      'state', ac.state,
      'due_date', ac.due_date,
      'note', ac.note,
      'updated_at', ac.updated_at
    ) end
  from public.pulse_alerts al
  join public.employees e on e.employee_number = al.employee_number
  join public.pulse_cycles c on c.id = al.cycle_id
  left join public.pulse_alert_rules ar on ar.code = al.type
  left join public.pulse_alert_actions ac on ac.alert_id = al.id
  left join public.employees ase on ase.employee_number = ac.assignee_employee_number
  left join public.pulse_responses r on r.cycle_id = al.cycle_id and r.employee_number = al.employee_number
  left join public.pulse_comment_classifications cc on cc.response_id = r.id
  left join lateral (
    select sum(a.score) as sum_score
    from public.pulse_answers a
    join public.pulse_questions q on q.id = a.question_id
    where a.response_id = r.id and a.score is not null and q.type in ('weather5','scale')
  ) ss on true
  left join lateral (
    select sum(a2.score) as sum_score
    from public.pulse_responses r2
    join public.pulse_cycles c2 on c2.id = r2.cycle_id
    join public.pulse_answers a2 on a2.response_id = r2.id
    join public.pulse_questions q2 on q2.id = a2.question_id
    where r2.employee_number = al.employee_number
      and c2.period < c.period
      and c2.status in ('sent','closed')
      and a2.score is not null and q2.type in ('weather5','scale')
    group by r2.id, c2.period
    order by c2.period desc
    limit 1
  ) ps on true
  where (
      (p_cycle_id is not null and al.cycle_id = p_cycle_id)
      or (p_cycle_id is null and c.id in (
            select pc.id from public.pulse_cycles pc order by pc.period desc limit 12
          ))
    )
    and public.pulse_can_view_employee(al.employee_number)
    and (v_scope <> 'own_unit' or al.disclose_to_manager)
  order by
    case al.status when 'open' then 0 else 1 end,
    case al.severity when 'critical' then 0 when 'warn' then 1 else 2 end,
    al.created_at desc;
end;
$$;

revoke all on function public.pulse_list_alerts(uuid) from public, anon;
grant execute on function public.pulse_list_alerts(uuid) to authenticated, service_role;

-- ══ 10-6d. pulse_alert_digest_batch / pulse_mark_alerts_notified ═══════
create or replace function public.pulse_alert_digest_batch(p_alert_ids uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_settings public.pulse_settings%rowtype;
  v_recipients jsonb;
  v_alerts jsonb;
  v_open_total int;
  v_by_state jsonb;
begin
  select * into v_settings from public.pulse_settings where id = 1;

  select coalesce(jsonb_agg(jsonb_build_object('email', em.email, 'name', coalesce(e.display_name, e.full_name))), '[]'::jsonb)
    into v_recipients
  from unnest(coalesce(v_settings.alert_digest_recipients, '{}'::text[])) as em(email)
  left join public.employees e on lower(coalesce(e.email, '')) = lower(em.email);

  select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', al.id,
        'period', c.period,
        'employee_number', al.employee_number,
        'name', coalesce(e.display_name, e.full_name, al.employee_number),
        'department', e.department,
        'rule_code', al.type,
        'rule_label', coalesce(ar.label, al.type),
        'severity', al.severity,
        'categories', to_jsonb(al.categories),
        'reason', al.reason,
        'comment_summary', cc.summary,
        'created_at', al.created_at
      )
      order by
        case al.severity when 'critical' then 0 when 'warn' then 1 else 2 end,
        c.period desc, al.created_at desc
    ), '[]'::jsonb)
    into v_alerts
  from public.pulse_alerts al
  join public.pulse_cycles c on c.id = al.cycle_id
  join public.employees e on e.employee_number = al.employee_number
  left join public.pulse_alert_rules ar on ar.code = al.type
  left join public.pulse_responses r on r.cycle_id = al.cycle_id and r.employee_number = al.employee_number
  left join public.pulse_comment_classifications cc on cc.response_id = r.id
  where (p_alert_ids is not null and al.id = any(p_alert_ids))
     or (p_alert_ids is null and al.status = 'open' and al.notified_at is null);

  select count(*) into v_open_total from public.pulse_alerts where status = 'open';

  select jsonb_build_object(
      'todo', count(*) filter (where coalesce(ac.state, 'todo') = 'todo'),
      'doing', count(*) filter (where ac.state = 'doing'),
      'on_hold_org', count(*) filter (where ac.state = 'on_hold_org'),
      'done', count(*) filter (where ac.state = 'done'),
      'not_needed', count(*) filter (where ac.state = 'not_needed')
    )
    into v_by_state
  from public.pulse_alerts al2
  left join public.pulse_alert_actions ac on ac.alert_id = al2.id
  where al2.status = 'open';

  return jsonb_build_object(
    'recipients', v_recipients,
    'digest_enabled', coalesce(v_settings.alert_digest_enabled, true),
    'immediate_enabled', coalesce(v_settings.alert_immediate_enabled, true),
    'alerts', v_alerts,
    'open_total', coalesce(v_open_total, 0),
    'by_state', coalesce(v_by_state, jsonb_build_object('todo',0,'doing',0,'on_hold_org',0,'done',0,'not_needed',0))
  );
end;
$$;

revoke all on function public.pulse_alert_digest_batch(uuid[]) from public, anon, authenticated;
grant execute on function public.pulse_alert_digest_batch(uuid[]) to service_role;

create or replace function public.pulse_mark_alerts_notified(p_alert_ids uuid[], p_kind text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if p_kind not in ('immediate','digest') then
    raise exception 'pulse_mark_alerts_notified: invalid kind %', p_kind;
  end if;
  update public.pulse_alerts
    set notified_at = now(), notified_kind = p_kind
  where id = any(coalesce(p_alert_ids, array[]::uuid[]));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.pulse_mark_alerts_notified(uuid[], text) from public, anon, authenticated;
grant execute on function public.pulse_mark_alerts_notified(uuid[], text) to service_role;

-- ══ 10-6e. pulse_cron_fire_alert_digest ＋ cron登録（0050と同型・09:10 JST） ══
create or replace function public.pulse_cron_fire_alert_digest()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_anon text;
  v_headers jsonb;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets where name = 'pulse_cron_secret' limit 1;

  if v_secret is null or btrim(v_secret) = '' then
    return 0;
  end if;

  select decrypted_secret into v_anon
  from vault.decrypted_secrets where name = 'pulse_anon_key' limit 1;

  v_headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret);
  if v_anon is not null and btrim(v_anon) <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || btrim(v_anon));
  end if;

  perform net.http_post(
    url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-alert-digest',
    headers := v_headers,
    body := jsonb_build_object('mode', 'daily'),
    timeout_milliseconds := 60000
  );

  return 1;
end;
$$;

revoke all on function public.pulse_cron_fire_alert_digest() from public, anon, authenticated, service_role;

-- 09:10 JST = 00:10 UTC（決定9の朝の枠。reminder の 09:00 と10分ずらす）。
select cron.schedule(
  'pulse-alert-digest',
  '10 0 * * *',
  $cron$select public.pulse_cron_fire_alert_digest()$cron$
)
where not exists (
  select 1 from cron.job where jobname = 'pulse-alert-digest'
);

-- ══ 10-1b/10-6f. pulse_update_alert_rule / pulse_update_alert_notify_settings ══
create or replace function public.pulse_update_alert_rule(p_id uuid, p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_allowed text[];
  v_key text;
  v_num numeric;
begin
  if not public.pulse_is_admin() then
    raise exception 'pulse_update_alert_rule: permission denied';
  end if;

  select code into v_code from public.pulse_alert_rules where id = p_id;
  if v_code is null then
    raise exception 'pulse_update_alert_rule: rule % not found', p_id;
  end if;

  if p_patch ? 'params' then
    v_allowed := case v_code
      when 'geppo_stormy' then array['threshold']
      when 'geppo_drop2' then array['drop','max_after']
      when 'geppo_rain2' then array['threshold','min_items']
      when 'preset_all_cloudy' then array['score']
      when 'preset_decline_3m' then array['months']
      when 'preset_same_3m' then array['months']
      when 'preset_unanswered_3m' then array['months']
      when 'legacy_absolute' then array['threshold']
      when 'legacy_delta' then array['drop']
      else array[]::text[]
    end;

    for v_key in select jsonb_object_keys(p_patch->'params') loop
      if not (v_key = any(v_allowed)) then
        raise exception 'invalid_params: % is not editable for rule %', v_key, v_code;
      end if;
      v_num := (p_patch->'params'->>v_key)::numeric;
      case v_key
        when 'threshold' then
          if v_num < 1 or v_num > 5 then raise exception 'invalid_params: threshold must be 1..5'; end if;
        when 'drop' then
          if v_num < 1 or v_num > 4 then raise exception 'invalid_params: drop must be 1..4'; end if;
        when 'max_after' then
          if v_num < 1 or v_num > 5 then raise exception 'invalid_params: max_after must be 1..5'; end if;
        when 'min_items' then
          if v_num < 1 or v_num > 4 then raise exception 'invalid_params: min_items must be 1..4'; end if;
        when 'score' then
          if v_num < 1 or v_num > 5 then raise exception 'invalid_params: score must be 1..5'; end if;
        when 'months' then
          if v_num < 2 or v_num > 6 then raise exception 'invalid_params: months must be 2..6'; end if;
        else
          raise exception 'invalid_params: unknown key %', v_key;
      end case;
    end loop;

    update public.pulse_alert_rules
      set params = coalesce(params, '{}'::jsonb) || (p_patch->'params')
    where id = p_id;
  end if;

  if p_patch ? 'is_active' then
    update public.pulse_alert_rules set is_active = (p_patch->>'is_active')::boolean where id = p_id;
  end if;
  if p_patch ? 'notify_immediately' then
    update public.pulse_alert_rules set notify_immediately = (p_patch->>'notify_immediately')::boolean where id = p_id;
  end if;
  if p_patch ? 'disclose_to_manager' then
    update public.pulse_alert_rules set disclose_to_manager = (p_patch->>'disclose_to_manager')::boolean where id = p_id;
  end if;
  -- label/code/source は変更不可＝patch に含まれていても無視する。
end;
$$;

revoke all on function public.pulse_update_alert_rule(uuid, jsonb) from public, anon;
grant execute on function public.pulse_update_alert_rule(uuid, jsonb) to authenticated, service_role;

create or replace function public.pulse_update_alert_notify_settings(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emails text[];
  v_bad text;
begin
  if not public.pulse_is_admin() then
    raise exception 'pulse_update_alert_notify_settings: permission denied';
  end if;

  if p_patch ? 'alert_digest_recipients' then
    select array_agg(distinct lower(btrim(x))) into v_emails
    from jsonb_array_elements_text(p_patch->'alert_digest_recipients') x
    where btrim(x) <> '';

    select btrim(x) into v_bad
    from jsonb_array_elements_text(p_patch->'alert_digest_recipients') x
    where btrim(x) <> ''
      and not exists (
        select 1 from public.employees e
        where e.left_at is null and lower(coalesce(e.email, '')) = lower(btrim(x))
      )
    limit 1;
    if v_bad is not null then
      raise exception 'pulse_update_alert_notify_settings: % is not an in-service employee email', v_bad;
    end if;

    update public.pulse_settings
      set alert_digest_recipients = coalesce(v_emails, array[]::text[])
    where id = 1;
  end if;

  if p_patch ? 'alert_digest_enabled' then
    update public.pulse_settings set alert_digest_enabled = (p_patch->>'alert_digest_enabled')::boolean where id = 1;
  end if;
  if p_patch ? 'alert_immediate_enabled' then
    update public.pulse_settings set alert_immediate_enabled = (p_patch->>'alert_immediate_enabled')::boolean where id = 1;
  end if;
  -- updated_at/updated_by_email は 0049 の pulse_settings_touch_updated_at
  -- トリガが上記いずれかの UPDATE で自動的に付与する（ここでは再設定しない）。
end;
$$;

revoke all on function public.pulse_update_alert_notify_settings(jsonb) from public, anon;
grant execute on function public.pulse_update_alert_notify_settings(jsonb) to authenticated, service_role;

-- ══ 10-7. 振り返り・KPI（authenticated・pulse_can_manage_alert ゲート） ═══
-- own_unit スコープには disclose_to_manager=true の行だけを算入する（10-5の
-- pulse_list_alerts と同じ防御。現状 own_unit×can_manage_alert の組合せは
-- 到達不能だが、将来 P5 で有効になっても会社全体の数字が漏れないようにする）。
create or replace function public.pulse_alert_kpis(p_period text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_scope text := public.pulse_scope();
  v_emp text := public.pulse_current_employee_number();
  v_alerted int;
  v_open int;
  v_my_open int;
  v_by_state jsonb;
  v_trend jsonb;
begin
  if not public.pulse_can_manage_alert() then
    return null;
  end if;

  select count(distinct al.employee_number) into v_alerted
  from public.pulse_alerts al
  join public.pulse_cycles c on c.id = al.cycle_id
  where c.period = p_period
    and public.pulse_can_view_employee(al.employee_number)
    and (v_scope <> 'own_unit' or al.disclose_to_manager);

  select count(*) into v_open
  from public.pulse_alerts al
  where al.status = 'open'
    and public.pulse_can_view_employee(al.employee_number)
    and (v_scope <> 'own_unit' or al.disclose_to_manager);

  select count(*) into v_my_open
  from public.pulse_alerts al
  join public.pulse_alert_actions ac on ac.alert_id = al.id
  where al.status = 'open'
    and v_emp is not null
    and ac.assignee_employee_number = v_emp
    and public.pulse_can_view_employee(al.employee_number)
    and (v_scope <> 'own_unit' or al.disclose_to_manager);

  select jsonb_build_object(
      'todo', count(*) filter (where coalesce(ac.state, 'todo') = 'todo'),
      'doing', count(*) filter (where ac.state = 'doing'),
      'on_hold_org', count(*) filter (where ac.state = 'on_hold_org'),
      'done', count(*) filter (where ac.state = 'done'),
      'not_needed', count(*) filter (where ac.state = 'not_needed')
    )
    into v_by_state
  from public.pulse_alerts al
  join public.pulse_cycles c on c.id = al.cycle_id
  left join public.pulse_alert_actions ac on ac.alert_id = al.id
  where c.period = p_period
    and public.pulse_can_view_employee(al.employee_number)
    and (v_scope <> 'own_unit' or al.disclose_to_manager);

  select coalesce(jsonb_agg(jsonb_build_object('period', t.period, 'alerted_employees', t.n) order by t.period asc), '[]'::jsonb)
    into v_trend
  from (
    -- 直近12サイクル（sent/closed）を軸にし、アラート0件の月も 0 で返す（棒グラフの欠け防止）
    select c.period,
           count(distinct al.employee_number) filter (
             where al.id is not null
               and public.pulse_can_view_employee(al.employee_number)
               and (v_scope <> 'own_unit' or al.disclose_to_manager)) as n
    from (
      select pc.id, pc.period from public.pulse_cycles pc
      where pc.status in ('sent','closed')
      order by pc.period desc limit 12
    ) c
    left join public.pulse_alerts al on al.cycle_id = c.id
    group by c.period
  ) t;

  return jsonb_build_object(
    'alerted_employees', coalesce(v_alerted, 0),
    'open_total', coalesce(v_open, 0),
    'my_open', coalesce(v_my_open, 0),
    'by_state', coalesce(v_by_state, jsonb_build_object('todo',0,'doing',0,'on_hold_org',0,'done',0,'not_needed',0)),
    'trend', v_trend
  );
end;
$$;

revoke all on function public.pulse_alert_kpis(text) from public, anon;
grant execute on function public.pulse_alert_kpis(text) to authenticated, service_role;

-- 当月にアラートがある本人ごとに、base(当月合計)→latest(その後最初に回答が
-- ある直近サイクル・+3か月以内)の推移。並びは設計書 §10-7 の記載どおり
-- delta desc nulls last（実装注記: delta = latest_sum - base_sum。値が大きい
-- ほど先頭＝改善が先に並ぶ向き。「悪化を先頭に」を意図するなら呼び出し側で
-- asc に変えるか本関数の order by を反転させる必要がある＝レビュー観点として
-- report に明記する）。
create or replace function public.pulse_alert_review(p_period text)
returns table (
  employee_number text,
  name text,
  department text,
  alert_types text[],
  base_period text,
  base_sum integer,
  latest_period text,
  latest_sum integer,
  delta integer,
  series jsonb,
  action_state text,
  action_title text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_realname boolean := public.pulse_can_view_realname();
  v_scope text := public.pulse_scope();
begin
  if not public.pulse_can_manage_alert() then
    raise exception 'pulse_alert_review: permission denied';
  end if;

  return query
  select
    b.employee_number,
    case when v_realname then coalesce(e.display_name, e.full_name, b.employee_number) else null end,
    e.department,
    b.alert_types,
    p_period,
    bs.sum_score::integer,
    lt.period,
    lt.sum_score::integer,
    case when lt.sum_score is not null and bs.sum_score is not null then (lt.sum_score - bs.sum_score)::integer else null end,
    coalesce(sr.series, '[]'::jsonb),
    act.state,
    act.title
  from (
    select al.employee_number, array_agg(distinct al.type order by al.type) as alert_types
    from public.pulse_alerts al
    join public.pulse_cycles c on c.id = al.cycle_id
    where c.period = p_period
      and public.pulse_can_view_employee(al.employee_number)
      and (v_scope <> 'own_unit' or al.disclose_to_manager)
    group by al.employee_number
  ) b
  join public.employees e on e.employee_number = b.employee_number
  left join lateral (
    select sum(a.score) filter (where a.score is not null and q.type in ('weather5','scale')) as sum_score
    from public.pulse_responses r
    join public.pulse_cycles c on c.id = r.cycle_id
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.employee_number = b.employee_number and c.period = p_period
    group by r.id
  ) bs on true
  left join lateral (
    select c.period, sum(a.score) filter (where a.score is not null and q.type in ('weather5','scale')) as sum_score
    from public.pulse_responses r
    join public.pulse_cycles c on c.id = r.cycle_id
    join public.pulse_answers a on a.response_id = r.id
    join public.pulse_questions q on q.id = a.question_id
    where r.employee_number = b.employee_number
      and c.period > p_period
      and c.status in ('sent','closed')
      and to_date(c.period||'-01','YYYY-MM-DD') <= to_date(p_period||'-01','YYYY-MM-DD') + interval '3 months'
    group by r.id, c.period
    order by c.period asc
    limit 1
  ) lt on true
  left join lateral (
    select jsonb_agg(jsonb_build_object('period', h.period, 'sum', h.sum_score) order by h.period asc) as series
    from (
      select c.period, sum(a.score) filter (where a.score is not null and q.type in ('weather5','scale')) as sum_score
      from public.pulse_responses r
      join public.pulse_cycles c on c.id = r.cycle_id
      join public.pulse_answers a on a.response_id = r.id
      join public.pulse_questions q on q.id = a.question_id
      where r.employee_number = b.employee_number
        and to_date(c.period||'-01','YYYY-MM-DD') between
            to_date(p_period||'-01','YYYY-MM-DD') - interval '2 months'
            and to_date(p_period||'-01','YYYY-MM-DD') + interval '3 months'
      group by r.id, c.period
    ) h
  ) sr on true
  left join lateral (
    select ac.state, ac.title
    from public.pulse_alerts al2
    join public.pulse_alert_actions ac on ac.alert_id = al2.id
    where al2.employee_number = b.employee_number
      and al2.cycle_id = (select id from public.pulse_cycles where period = p_period)
    order by al2.created_at desc
    limit 1
  ) act on true
  order by (lt.sum_score - bs.sum_score) desc nulls last;
end;
$$;

revoke all on function public.pulse_alert_review(text) from public, anon;
grant execute on function public.pulse_alert_review(text) to authenticated, service_role;

commit;
