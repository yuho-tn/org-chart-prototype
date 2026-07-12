-- ─────────────────────────────────────────────────────────────────────
-- 0032_pulse_production_activation
--
-- P4-⑤（本番活性化）。⚠️⚠️ **意図的に supabase/manual/ に置いてある** ⚠️⚠️
-- migrations/ に置くと次の `supabase db push` で無条件に適用され、検証用
-- テストデータが不可逆削除されるため。適用手順（裕鵬さん承認必須＝削除を伴う）:
--   1. P4（0029〜0031）のライブ検証を完了させる
--   2. 裕鵬さんの承認を得る（削除を伴うため必須）
--   3. このファイルを supabase/migrations/ へ「その時点の次番号」で mv して
--      `supabase db push --linked`
-- テストcycleを検証データとして使うため、0029〜0031 を先に適用 → 本番検証
-- → 最後に本migration の順を厳守。
--
--   1. テストデータ掃除 — 設問セット名が「【テスト】」で始まるセットに
--      紐づくサイクルを丸ごと削除（responses / answers / alerts /
--      alert_actions / notifications / summaries は FK cascade・
--      monthly_aggregates は period 指定で削除）。当該セットは archived 化
--      （active セットは削除不可の不可変ガードがあるため）。
--      → period '2026-07' 等が解放され、実運用サイクルを作れるようになる。
--   2. 本番初期設問セット seed — 「月次パルスサーベイ v1」（draft）
--      天気4問（仕事/対人/健康/評価）＋ eNPS 1問 ＋ 自由記述 1問。
--      文言は裕鵬さんが設定画面（#/pulse/admin）で最終編集 → active 化
--      → サイクル作成 → 一斉送信（初回はワンクリック承認）の運用フロー。
--
-- Idempotent（再実行安全: 掃除対象が無ければ no-op・seed は名前で重複防止）。
-- ─────────────────────────────────────────────────────────────────────

begin;

-- ══ 1. テストデータ掃除 ══════════════════════════════════════════════
do $$
declare
  v_set record;
  v_period text;
begin
  for v_set in
    select id, name, status from public.pulse_question_sets
    where name like '【テスト】%'
  loop
    -- 紐づくサイクルの period の集計・要約を掃除してからサイクル削除
    for v_period in
      select period from public.pulse_cycles where question_set_id = v_set.id
    loop
      delete from public.pulse_monthly_aggregates where period = v_period;
      -- summaries は cycle FK cascade でも消えるが、明示しておく
      delete from public.pulse_summaries where period = v_period;
    end loop;

    -- サイクル削除（responses/answers/alerts/actions/notifications は cascade）
    delete from public.pulse_cycles where question_set_id = v_set.id;

    -- セットは不可変ガード準拠で処分:
    --   draft → そのまま削除可 / active → archived 化 / archived → 放置
    if v_set.status = 'draft' then
      delete from public.pulse_question_sets where id = v_set.id;
    elsif v_set.status = 'active' then
      update public.pulse_question_sets set status = 'archived' where id = v_set.id;
    end if;
  end loop;
end;
$$;

-- ══ 2. 本番初期設問セット seed（draft・文言は裕鵬さん最終編集） ══════
do $$
declare
  v_set_id uuid;
begin
  if exists (
    select 1 from public.pulse_question_sets where name = '月次パルスサーベイ v1'
  ) then
    return;  -- seed 済み（再実行時は触らない）
  end if;

  insert into public.pulse_question_sets (name, version, status)
  values ('月次パルスサーベイ v1', 1, 'draft')
  returning id into v_set_id;

  insert into public.pulse_questions
    (question_set_id, sort_order, label, category, type) values
  (v_set_id, 1, '仕事の充実度・手応えはどうですか？', '仕事', 'weather5'),
  (v_set_id, 2, '職場の人間関係・コミュニケーションはどうですか？', '対人', 'weather5'),
  (v_set_id, 3, '心と体のコンディションはどうですか？', '健康', 'weather5'),
  (v_set_id, 4, '自分への評価・処遇に納得できていますか？', '評価', 'weather5'),
  (v_set_id, 5, 'SHO-SANで働くことを、親しい友人や知人にどの程度すすめたいですか？', 'eNPS', 'nps'),
  (v_set_id, 6, '共有したいこと・気になっていることがあれば自由にご記入ください', null, 'free_text');
end;
$$;

commit;
