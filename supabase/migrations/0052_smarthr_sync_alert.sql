-- ─────────────────────────────────────────────────────────────────────
-- 0052_smarthr_sync_alert
--
-- SmartHR 同期の「失敗に気づけない」を塞ぐ。
--
-- 背景（2026-09-23）:
--   SmartHR 側のサブドメイン改称（sho-san20220722mk → sho-san）で日次同期が
--   400 inactive を返し続けていたが、失敗は smarthr_sync_state.last_status に
--   書かれるだけで、UI では従業員マスター画面ヘッダの「最終同期」チップに
--   小さな ⚠ が付くのみだった（しかも master 相当のみ可視）。誰も見ておらず、
--   発見時には入社3名・退職4名＝計7件ぶん台帳がズレていた。
--
-- ここで用意するのは「壊れている」の判定と通知の土台:
--   1. smarthr_sync_state への通知用カラム追加（alert_enabled / last_alert_at /
--      last_alert_key / alert_recipients）
--   2. smarthr_sync_health()   … 何を「壊れている」と見なすかの唯一の定義。
--                                 UI のバッジと通知判定が同じ関数を読む
--                                 （別々に条件を書くと必ず食い違うため）
--   3. smarthr_alert_batch()   … 通知すべきか＋宛先＋本文材料を1回で返す
--   4. smarthr_mark_alerted()  … 通知済みの記録（連日の同報を抑える）
--   5. smarthr_cron_fire_sync_alert() … pg_cron 本体。Vault の
--      `smarthr_cron_secret` を読み、Edge Function `smarthr-alert` を叩く
--   6. cron.schedule('smarthr-sync-alert', …) を未登録の時だけ登録
--
-- 重要な設計判断:
--   • 「error」だけでなく「stale（規定時間 last_run_at が動いていない）」も
--     異常として扱う。cron 自体が死ぬ・関数が消える・Vault secret が失効した
--     場合、last_status は最後に成功した 'ok' のまま固まるため、error 監視
--     だけでは永久に気づけない（今回の事故と同じ構造の穴）。
--   • 一度も走っていない（last_run_at is null）は 'never' として別に扱う。
--   • 復旧時に1回だけ「復旧しました」を送る。送りっぱなしで放置すると、
--     直したのに追いかけ続ける人が出る。
--
-- secret の値はこのファイルに一切書かない。Vault へ `smarthr_cron_secret` を
-- 投入するまで smarthr_cron_fire_sync_alert() は何もせず 0 を返す
-- （本 migration 自体は secrets 未投入でも安全に流れる）。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ══ 1. 通知用カラム ══════════════════════════════════════════════════
alter table public.smarthr_sync_state
  add column if not exists alert_enabled boolean not null default true,
  add column if not exists last_alert_at timestamptz,
  add column if not exists last_alert_key text,
  add column if not exists alert_recipients text[];

comment on column public.smarthr_sync_state.alert_enabled is
  '失敗通知の on/off。既定 true。止めたい時だけ false にする。';
comment on column public.smarthr_sync_state.last_alert_at is
  '最後に通知を送った時刻。同じ障害を連日同報しないための基準。';
comment on column public.smarthr_sync_state.last_alert_key is
  '最後に通知した障害の識別子（状態＋原因の要約）。別の原因に変わったら'
  ' 抑止期間内でも即通知する。復旧通知を送ったら null に戻す。';
comment on column public.smarthr_sync_state.alert_recipients is
  '通知先メールの明示指定。null/空なら app_users の master/privileged_admin/admin'
  '（＝smarthr_can_sync と同じ「同期を直せる人」の集合）へ送る。';

-- ══ 2. smarthr_sync_health: 「壊れている」の唯一の定義 ════════════════
-- state:
--   'never' … 一度も同期が走っていない
--   'error' … 直近の同期が失敗（last_status='error'）
--   'stale' … 成功しているが last_run_at が p_stale_hours 以上動いていない
--             （＝cron・関数・secret のどれかが死んでいる）
--   'ok'    … 正常
create or replace function public.smarthr_sync_health(p_stale_hours integer default 36)
returns table (
  state text,
  last_run_at timestamptz,
  last_status text,
  age_hours numeric,
  detail text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    case
      when s.last_run_at is null then 'never'
      when s.last_status = 'error' then 'error'
      when s.last_run_at < now() - make_interval(hours => p_stale_hours) then 'stale'
      else 'ok'
    end as state,
    s.last_run_at,
    s.last_status,
    round(extract(epoch from (now() - s.last_run_at)) / 3600.0, 1) as age_hours,
    case
      when s.last_run_at is null then 'SmartHR同期が一度も実行されていません'
      when s.last_status = 'error' then
        coalesce(nullif(btrim(s.summary ->> 'error'), ''), '直近の同期が失敗しました（詳細不明）')
      when s.last_run_at < now() - make_interval(hours => p_stale_hours) then
        'SmartHR同期が ' || round(extract(epoch from (now() - s.last_run_at)) / 3600.0)::text
        || ' 時間動いていません（定期実行・secret・関数のいずれかを確認してください）'
      else '正常'
    end as detail
  from public.smarthr_sync_state s
  where s.id = true
$$;

-- UI のバッジが読む＝authenticated にも開ける（中身は同期の健全性のみ）。
revoke all on function public.smarthr_sync_health(integer) from public, anon;
grant execute on function public.smarthr_sync_health(integer) to authenticated, service_role;

-- ══ 3. smarthr_alert_batch: 通知すべきか＋宛先＋材料 ══════════════════
-- kind: 'failure'（異常の通知）/ 'recovery'（復旧の通知）/ null（送らない）
-- p_repeat_hours は「日次 cron の間隔（24h）より短く」すること。24 にすると
-- 経過が 23:59:58 のような僅差で条件を外し、その日を飛ばして次は48時間後＝
-- 壊れている間の通知が1日おきになる。既定 20h（呼び出し側 Edge Function も 20）。
create or replace function public.smarthr_alert_batch(
  p_stale_hours integer default 36,
  p_repeat_hours integer default 20
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_h record;
  v_st record;
  v_key text;
  v_kind text := null;
  v_recipients text[];
begin
  select * into v_h from public.smarthr_sync_health(p_stale_hours);
  select alert_enabled, last_alert_at, last_alert_key, alert_recipients
    into v_st
  from public.smarthr_sync_state where id = true;

  -- シングルトン行は 0036 が必ず作るが、消えていた場合に「原因不明の通知」を
  -- 撒かないよう、判定材料が無ければ何もしない。
  if v_h.state is null then
    return jsonb_build_object('kind', null::text, 'state', null::text,
                              'recipients', '[]'::jsonb,
                              'detail', 'smarthr_sync_state の行がありません');
  end if;

  -- 障害の識別子＝状態＋原因の先頭120字。原因が変われば別の障害として扱う。
  v_key := v_h.state || ':' || left(coalesce(v_h.detail, ''), 120);

  if v_h.state = 'ok' then
    -- 直前まで通知していた障害が消えた時だけ、復旧を1回知らせる。
    if v_st.last_alert_key is not null then
      v_kind := 'recovery';
    end if;
  else
    if v_st.last_alert_key is distinct from v_key then
      v_kind := 'failure';                    -- 新しい原因＝抑止期間内でも即通知
    elsif v_st.last_alert_at is null
       or v_st.last_alert_at < now() - make_interval(hours => p_repeat_hours) then
      v_kind := 'failure';                    -- 同じ原因は p_repeat_hours ごとに再通知
    end if;
  end if;

  if not coalesce(v_st.alert_enabled, true) then
    v_kind := null;                           -- 明示的に止めている
  end if;

  -- 宛先: 明示指定があればそれ。無ければ「同期を直せる人」＝smarthr_can_sync と同じ集合。
  if v_st.alert_recipients is not null and array_length(v_st.alert_recipients, 1) > 0 then
    v_recipients := v_st.alert_recipients;
  else
    select coalesce(array_agg(lower(email) order by email), '{}'::text[])
      into v_recipients
    from public.app_users
    where role in ('master', 'privileged_admin', 'admin')
      and email is not null
      and email like '%@%';
  end if;

  return jsonb_build_object(
    'kind', v_kind,
    'alert_key', v_key,
    'state', v_h.state,
    'detail', v_h.detail,
    'last_run_at', v_h.last_run_at,
    'age_hours', v_h.age_hours,
    'alert_enabled', coalesce(v_st.alert_enabled, true),
    'last_alert_at', v_st.last_alert_at,
    'recipients', to_jsonb(v_recipients)
  );
end;
$$;

-- Edge Function(service_role) 専用。宛先一覧を含むため authenticated には渡さない。
revoke all on function public.smarthr_alert_batch(integer, integer) from public, anon, authenticated;
grant execute on function public.smarthr_alert_batch(integer, integer) to service_role;

-- ══ 4. smarthr_mark_alerted: 通知済みの記録 ══════════════════════════
-- p_key を渡すと「その障害を通知済み」、null を渡すと（復旧通知後に）記録を消す。
create or replace function public.smarthr_mark_alerted(p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.smarthr_sync_state
     set last_alert_at = now(),
         last_alert_key = p_key,
         updated_at = now()
   where id = true
$$;

revoke all on function public.smarthr_mark_alerted(text) from public, anon, authenticated;
grant execute on function public.smarthr_mark_alerted(text) to service_role;

-- ══ 5. pg_cron 本体（0050 pulse_cron_fire_reminders と同型） ══════════
create or replace function public.smarthr_cron_fire_sync_alert()
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
  from vault.decrypted_secrets
  where name = 'smarthr_cron_secret'
  limit 1;

  if v_secret is null or btrim(v_secret) = '' then
    return 0;                                  -- 未投入なら何もしない
  end if;

  -- smarthr-alert は verify_jwt=false でデプロイする前提（関数内で x-cron-secret を
  -- 検証）だが、誤って verify_jwt=true で再デプロイされてもゲートウェイで 401 に
  -- ならないよう、Vault に 'pulse_anon_key'（公開 anon key）があれば付ける。
  select decrypted_secret into v_anon
  from vault.decrypted_secrets
  where name = 'pulse_anon_key'
  limit 1;

  v_headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', v_secret
  );
  if v_anon is not null and btrim(v_anon) <> '' then
    v_headers := v_headers || jsonb_build_object('Authorization', 'Bearer ' || btrim(v_anon));
  end if;

  perform net.http_post(
    url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/smarthr-alert',
    headers := v_headers,
    body := jsonb_build_object('mode', 'check'),
    timeout_milliseconds := 60000
  );

  return 1;
end;
$$;

revoke all on function public.smarthr_cron_fire_sync_alert() from public, anon, authenticated;

-- ══ 6. cron 登録（未登録の時だけ・毎日 10:00 JST = 01:00 UTC） ════════
-- 日次同期（早朝）より後に置く。36h 判定なので多少ずれても誤報にはならない。
select cron.schedule(
  'smarthr-sync-alert',
  '0 1 * * *',
  $cron$select public.smarthr_cron_fire_sync_alert()$cron$
)
where not exists (
  select 1 from cron.job where jobname = 'smarthr-sync-alert'
);

commit;
