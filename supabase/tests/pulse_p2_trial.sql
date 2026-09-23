-- ─────────────────────────────────────────────────────────────────────
-- pulse_p2_trial.sql
--
-- 0051_pulse_v3_p2.sql 適用後に走らせる検証 SQL（このファイル自体は 0051 の
-- 本体を含まない＝CEOが 0051 適用後の DB に対して直接このファイルを実行する）。
--
-- 方針: begin; → テスト用サイクル3本(period '2031-01'/'2031-02'/'2031-03'・
-- 実在しない未来の期間なので本番データと衝突しない)＋設問セット＋在籍社員
-- 4名分の回答を直接 pulse_responses/pulse_answers へ insert（pulse__submit_response
-- は経由しない＝各ルールの境界値を素材ごとに厳密に作り込むため）→
-- pulse__evaluate_employee / pulse_evaluate_cycle_rules を直接呼んで判定 →
-- assert → rollback;（本番データは一切変更しない）。
--
-- pg_net を実発火させない安全弁: begin 直後に `set local pulse.trial = '1'`
-- する（0051 の pulse__request_classification / pulse__request_immediate が
-- これを見て no-op になる）。もっとも本トライアルは pulse__submit_response /
-- pulse_apply_classification を経由せず pulse__evaluate_employee を直接呼ぶ
-- ため、実際にはこの2関数は呼ばれない（保険として設定するだけ）。
--
-- 対象社員: 在籍の正社員から4名を動的に取得（E1〜E3=回答あり・E4=無回答＝
-- preset_unanswered_3m 用）。ブリーフの「3名分の回答」に対し1名（E4）を追加
-- しているのは、未回答ルールの検証には「回答が無い対象者」が構造的に必須
-- なため（詳細は本ファイル冒頭の各ケース設計コメントを参照）。
--
-- 検証する9ケース（ブリーフの指定どおり）:
--   1. 荒天（geppo_stormy）             … E1×C3
--   2. 2段階下落で雨（geppo_drop2）      … E1×C3（同じ項目で stormy と同時発火）
--   3. 雨2項目（geppo_rain2）            … E2×C3
--   4. 全くもり（preset_all_cloudy）     … E3×C3
--   5. 3か月連続下降（preset_decline_3m）… E3×C3
--   6. 3か月同回答（preset_same_3m）     … E2×C3
--   7. 主務変更（preset_org_change）     … E2×C3
--   8. 3か月未回答（preset_unanswered_3m）… E4×C3（pulse_evaluate_cycle_rules）
--   9. 回答修正で削除                    … E1×C3 を訂正→再評価→stormy/drop2 が消える
--
-- 対象外（意図的にスコープ外・ブリーフの9件に含まれないため）:
--   comment_*（コメント分類）系ルールの発火・pulse_apply_classification・
--   pulse_pending_classifications は未検証。classification 経路は
--   pulse_comment_classifications への直接 insert が必要で、かつ
--   pulse__request_immediate の実発火有無の検証には Edge Function が要る
--   ため、この SQL 単体トライアルの範囲外とした（CEOへの報告に明記）。
-- ─────────────────────────────────────────────────────────────────────

begin;

set local pulse.trial = '1';

do $$
declare
  v_qset_id uuid := gen_random_uuid();
  v_q_work uuid := gen_random_uuid();
  v_q_rel uuid := gen_random_uuid();
  v_q_health uuid := gen_random_uuid();
  v_q_eval uuid := gen_random_uuid();

  v_c1 uuid := gen_random_uuid();
  v_c2 uuid := gen_random_uuid();
  v_c3 uuid := gen_random_uuid();

  v_e1 text;
  v_e2 text;
  v_e3 text;
  v_e4 text;

  v_r1_1 uuid; v_r1_2 uuid; v_r1_3 uuid;
  v_r2_1 uuid; v_r2_2 uuid; v_r2_3 uuid;
  v_r3_1 uuid; v_r3_2 uuid; v_r3_3 uuid;

  v_eval jsonb;
  v_cycle_count int;
  v_alert_count int;
begin
  -- ── 0. 対象社員4名を動的取得（在籍・正社員。ブリーフ指定のクエリに準拠） ──
  select employee_number into v_e1 from public.employees
    where left_at is null and employment_type = '正社員' order by employee_number limit 1;
  select employee_number into v_e2 from public.employees
    where left_at is null and employment_type = '正社員' and employee_number <> v_e1
    order by employee_number limit 1 offset 1;
  select employee_number into v_e3 from public.employees
    where left_at is null and employment_type = '正社員' and employee_number not in (v_e1, v_e2)
    order by employee_number limit 1 offset 2;
  select employee_number into v_e4 from public.employees
    where left_at is null and employment_type = '正社員' and employee_number not in (v_e1, v_e2, v_e3)
    order by employee_number limit 1 offset 3;

  assert v_e1 is not null and v_e2 is not null and v_e3 is not null and v_e4 is not null,
    'setup: 在籍正社員が4名以上必要（本番データ不足でトライアル前提が崩れている）';

  raise notice 'trial subjects: E1=% E2=% E3=% E4=%', v_e1, v_e2, v_e3, v_e4;

  -- ── 1. テスト用設問セット・設問（天気4カテゴリ） ─────────────────────
  -- 0021 の guard: セットは draft でしか insert できず、設問は親が draft の間だけ
  -- 追加できる → draft で作成 → 設問挿入 → active へ遷移、の順で組む。
  insert into public.pulse_question_sets (id, name, version, status)
  values (v_qset_id, 'P2トライアル用設問セット', 1, 'draft');

  insert into public.pulse_questions (id, question_set_id, sort_order, label, category, type, is_active)
  values
    (v_q_work, v_qset_id, 1, '仕事の充実度', '仕事', 'weather5', true),
    (v_q_rel, v_qset_id, 2, '人間関係', '対人', 'weather5', true),
    (v_q_health, v_qset_id, 3, '心と体の調子', '健康', 'weather5', true),
    (v_q_eval, v_qset_id, 4, '評価への納得感', '評価', 'weather5', true);

  update public.pulse_question_sets
  set status = 'active', activated_at = now()
  where id = v_qset_id;

  -- ── 2. テスト用サイクル3本（2031-01/02/03）。C3=closed で
  --     preset_unanswered_3m の「当サイクルが closed」条件を満たす。 ──────
  insert into public.pulse_cycles (id, period, question_set_id, status, send_date, due_date)
  values
    (v_c1, '2031-01', v_qset_id, 'sent', '2031-01-15', '2031-01-31'),
    (v_c2, '2031-02', v_qset_id, 'sent', '2031-02-15', '2031-02-28'),
    (v_c3, '2031-03', v_qset_id, 'closed', '2031-03-15', '2031-03-31');

  -- ── 3. E1: 仕事が C2=4→C3=1（geppo_stormy ＋ geppo_drop2 を同時に作る）。
  --     他3項目は C1〜C3 とも4で一定（decline/same/all_cloudy を誤発火させない）。
  --     部署は3サイクルとも同一（org_change を誤発火させない）。 ──────────
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c1, v_e1, 'native', now(), 'P2トライアル部')
  returning id into v_r1_1;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c2, v_e1, 'native', now(), 'P2トライアル部')
  returning id into v_r1_2;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c3, v_e1, 'native', now(), 'P2トライアル部')
  returning id into v_r1_3;

  insert into public.pulse_answers (response_id, question_id, score) values
    (v_r1_1, v_q_work, 4), (v_r1_1, v_q_rel, 4), (v_r1_1, v_q_health, 4), (v_r1_1, v_q_eval, 4),
    (v_r1_2, v_q_work, 4), (v_r1_2, v_q_rel, 4), (v_r1_2, v_q_health, 4), (v_r1_2, v_q_eval, 4),
    (v_r1_3, v_q_work, 1), (v_r1_3, v_q_rel, 4), (v_r1_3, v_q_health, 4), (v_r1_3, v_q_eval, 4);

  -- ── 4. E2: 対人=健康=2・仕事=評価=4 を3サイクルとも同一（geppo_rain2 ＋
  --     preset_same_3m）。部署は C2→C3 で変更（preset_org_change）。 ──────
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c1, v_e2, 'native', now(), '本部')
  returning id into v_r2_1;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c2, v_e2, 'native', now(), '本部')
  returning id into v_r2_2;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c3, v_e2, 'native', now(), '開発部')
  returning id into v_r2_3;

  insert into public.pulse_answers (response_id, question_id, score) values
    (v_r2_1, v_q_work, 4), (v_r2_1, v_q_rel, 2), (v_r2_1, v_q_health, 2), (v_r2_1, v_q_eval, 4),
    (v_r2_2, v_q_work, 4), (v_r2_2, v_q_rel, 2), (v_r2_2, v_q_health, 2), (v_r2_2, v_q_eval, 4),
    (v_r2_3, v_q_work, 4), (v_r2_3, v_q_rel, 2), (v_r2_3, v_q_health, 2), (v_r2_3, v_q_eval, 4);

  -- ── 5. E3: 全4項目が C1=5→C2=4→C3=3（preset_decline_3m ＋ C3で全て3＝
  --     preset_all_cloudy）。部署は一定。 ──────────────────────────────
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c1, v_e3, 'native', now(), 'P2トライアル部')
  returning id into v_r3_1;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c2, v_e3, 'native', now(), 'P2トライアル部')
  returning id into v_r3_2;
  insert into public.pulse_responses (cycle_id, employee_number, source, answered_at, snap_department)
  values (v_c3, v_e3, 'native', now(), 'P2トライアル部')
  returning id into v_r3_3;

  insert into public.pulse_answers (response_id, question_id, score) values
    (v_r3_1, v_q_work, 5), (v_r3_1, v_q_rel, 5), (v_r3_1, v_q_health, 5), (v_r3_1, v_q_eval, 5),
    (v_r3_2, v_q_work, 4), (v_r3_2, v_q_rel, 4), (v_r3_2, v_q_health, 4), (v_r3_2, v_q_eval, 4),
    (v_r3_3, v_q_work, 3), (v_r3_3, v_q_rel, 3), (v_r3_3, v_q_health, 3), (v_r3_3, v_q_eval, 3);

  -- E4 は一切 pulse_responses を作らない（preset_unanswered_3m 用の無回答者）。

  -- ── 6. 判定実行（本人×C3）。E1/E2/E3 それぞれについて pulse__evaluate_employee
  --     を直接呼ぶ（pulse__submit_response は経由しない）。 ────────────
  v_eval := public.pulse__evaluate_employee(v_e1, v_c3);
  raise notice 'E1 eval: %', v_eval;
  v_eval := public.pulse__evaluate_employee(v_e2, v_c3);
  raise notice 'E2 eval: %', v_eval;
  v_eval := public.pulse__evaluate_employee(v_e3, v_c3);
  raise notice 'E3 eval: %', v_eval;

  -- ── ケース1: geppo_stormy（E1×C3・仕事=1） ───────────────────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e1 and cycle_id = v_c3 and type = 'geppo_stormy'
  ), 'FAIL case1 geppo_stormy: E1×C3 にアラートが無い';

  -- ── ケース2: geppo_drop2（E1×C3・仕事が C2:4→C3:1） ─────────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e1 and cycle_id = v_c3 and type = 'geppo_drop2'
  ), 'FAIL case2 geppo_drop2: E1×C3 にアラートが無い';

  -- ── ケース3: geppo_rain2（E2×C3・対人=健康=2の2項目） ───────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e2 and cycle_id = v_c3 and type = 'geppo_rain2'
  ), 'FAIL case3 geppo_rain2: E2×C3 にアラートが無い';

  -- ── ケース4: preset_all_cloudy（E3×C3・全4項目=3） ───────────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e3 and cycle_id = v_c3 and type = 'preset_all_cloudy'
  ), 'FAIL case4 preset_all_cloudy: E3×C3 にアラートが無い';

  -- ── ケース5: preset_decline_3m（E3×C3・5→4→3） ──────────────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e3 and cycle_id = v_c3 and type = 'preset_decline_3m'
  ), 'FAIL case5 preset_decline_3m: E3×C3 にアラートが無い';

  -- ── ケース6: preset_same_3m（E2×C3・天気4問が3サイクルとも同一） ────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e2 and cycle_id = v_c3 and type = 'preset_same_3m'
  ), 'FAIL case6 preset_same_3m: E2×C3 にアラートが無い';

  -- ── ケース7: preset_org_change（E2×C3・本部→開発部） ────────────
  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e2 and cycle_id = v_c3 and type = 'preset_org_change'
      and reason->>'prev_department' = '本部' and reason->>'department' = '開発部'
  ), 'FAIL case7 preset_org_change: E2×C3 にアラートが無いか reason が不一致';

  -- ── ケース8: preset_unanswered_3m（E4・C1〜C3すべて無回答）。
  --     pulse_evaluate_cycle_rules(C3) をサイクル単位で実行。 ────────
  select public.pulse_evaluate_cycle_rules(v_c3) into v_cycle_count;
  raise notice 'pulse_evaluate_cycle_rules(C3) upserted=%', v_cycle_count;

  assert exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e4 and cycle_id = v_c3 and type = 'preset_unanswered_3m'
  ), 'FAIL case8 preset_unanswered_3m: E4×C3 にアラートが無い';

  -- E1/E2/E3 は回答済みなので unanswered_3m は発火しないはず。
  assert not exists (
    select 1 from public.pulse_alerts
    where employee_number in (v_e1, v_e2, v_e3) and cycle_id = v_c3 and type = 'preset_unanswered_3m'
  ), 'FAIL case8 side-check: 回答済みの E1/E2/E3 に unanswered_3m が誤発火している';

  -- ── ケース9: 回答修正で削除（E1×C3の仕事を1→4に訂正→再評価→
  --     geppo_stormy/geppo_drop2 が消えること。notified_at is null かつ
  --     対応レコード無しの前提で delete される想定＝本トライアルは両方とも
  --     未着手のままなので条件を満たす）。 ──────────────────────────
  update public.pulse_answers set score = 4
  where response_id = v_r1_3 and question_id = v_q_work;

  v_eval := public.pulse__evaluate_employee(v_e1, v_c3);
  raise notice 'E1 re-eval after correction: %', v_eval;

  assert not exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e1 and cycle_id = v_c3 and type = 'geppo_stormy'
  ), 'FAIL case9a: 訂正後も geppo_stormy が残っている（delete-on-correction が効いていない）';

  assert not exists (
    select 1 from public.pulse_alerts
    where employee_number = v_e1 and cycle_id = v_c3 and type = 'geppo_drop2'
  ), 'FAIL case9b: 訂正後も geppo_drop2 が残っている（delete-on-correction が効いていない）';

  -- ── 副次チェック: legacy_* は既定OFFなので誰にも発火していないこと。 ──
  select count(*) into v_alert_count
  from public.pulse_alerts
  where cycle_id in (v_c1, v_c2, v_c3) and type in ('legacy_absolute', 'legacy_delta');
  assert v_alert_count = 0, 'FAIL side-check: legacy_* ルールが既定OFFなのに発火している';

  raise notice 'P2 trial OK — 9ケースすべて確認済み（comment_* 系は範囲外・冒頭コメント参照）';
end $$;

rollback;
