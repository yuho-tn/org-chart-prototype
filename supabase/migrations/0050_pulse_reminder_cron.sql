-- ─────────────────────────────────────────────────────────────────────
-- 0050_pulse_reminder_cron
--
-- パルスサーベイ v3 P1: 締切前リマインドの自動化（設計書 §3-11）。
-- 決定9: 配信日は毎月15日9:00・リマインドは2営業日おき×最大4回・月末締切。
--
-- secret の値はこのファイルには一切書かない。裕鵬さんが Supabase Vault へ
-- `pulse_cron_secret` を1回投入するまでは pulse_cron_fire_reminders() が
-- 何もせず 0 を返すだけ（本 migration 自体は secrets 未投入でも安全に流れる）。
-- 投入手順・確認SQLは docs/PULSE_ACTIVATION_RUNBOOK.md §④ を参照。
--
-- 内容:
--   1. pg_cron / pg_net 拡張を有効化
--   2. pulse_cron_due_cycles(p_today) — 今日リマインド対象のサイクルを
--      返す dry-run 用 SELECT 関数（営業日ベース。pulse_business_days_after
--      / pulse_is_business_day / pulse_settings.reminder_* を使う）
--   3. pulse_cron_fire_reminders() — pg_cron から日次で呼ばれる本体。
--      Vault から secret を読み、無ければ何もせず 0 を返す。ある場合は
--      due な各サイクルについて Edge Function pulse-notify(mode=reminder)
--      へ net.http_post する。authenticated/anon から revoke（cron は
--      postgres ロールで動く＝EXECUTE grant が無くても呼べる）
--   4. cron.schedule('pulse-reminders', '0 0 * * *', ...) を未登録の時だけ
--      登録（毎日 09:00 JST = 00:00 UTC）
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

begin;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ══ 1. pulse_cron_due_cycles: 今日リマインド対象のサイクル（dry-run可） ══
-- 条件: status='sent' かつ send_date/due_date が設定済み かつ due_date が
-- 今日以降 かつ 今日が営業日 かつ bd=pulse_business_days_after(send_date,今日)
-- が interval の倍数（bd>0）かつ bd/interval が max_count 以下。
create or replace function public.pulse_cron_due_cycles(p_today date default current_date)
returns table (cycle_id uuid, period text, business_days integer)
language sql
security definer
set search_path = public
stable
as $$
  with candidate as (
    select
      c.id,
      c.period,
      s.reminder_interval_business_days as interval_days,
      s.reminder_max_count as max_count,
      public.pulse_business_days_after(c.send_date, p_today) as bd
    from public.pulse_cycles c
    cross join public.pulse_settings s
    where c.status = 'sent'
      and c.send_date is not null
      and c.due_date is not null
      and c.due_date >= p_today
  )
  select id as cycle_id, period, bd as business_days
  from candidate
  where public.pulse_is_business_day(p_today)
    and bd > 0
    and bd % interval_days = 0
    and bd / interval_days <= max_count
$$;

-- dry-run は SQL Editor（postgres）から。authenticated へは渡さない。
revoke all on function public.pulse_cron_due_cycles(date) from public, anon, authenticated;
grant execute on function public.pulse_cron_due_cycles(date) to service_role;

-- ══ 2. pulse_cron_fire_reminders: pg_cron 本体 ═══════════════════════
-- Functions URL は secret ではないため関数内に定数で持つ（design書 §3-11）。
create or replace function public.pulse_cron_fire_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret text;
  v_anon text;
  v_headers jsonb;
  v_count integer := 0;
  v_cycle record;
  v_today date := current_date;
begin
  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'pulse_cron_secret'
  limit 1;

  if v_secret is null or btrim(v_secret) = '' then
    return 0;
  end if;

  -- pulse-notify は verify_jwt=false でデプロイする前提（関数内で x-cron-secret を検証）だが、
  -- 誤って verify_jwt=true で再デプロイされてもゲートウェイで 401 にならないよう、
  -- Vault に 'pulse_anon_key'（公開 anon key）があれば Authorization も付ける（任意）。
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

  for v_cycle in
    select cycle_id from public.pulse_cron_due_cycles(v_today)
  loop
    -- 未回答者 60 名超 × Slack lookup+post は 10〜20 秒かかるため、pg_net 既定 5 秒では
    -- 先に切断される。60 秒に延ばす（結果は net._http_response で確認できる）。
    perform net.http_post(
      url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-notify',
      headers := v_headers,
      body := jsonb_build_object(
        'cycle_id', v_cycle.cycle_id::text,
        'mode', 'reminder'
      ),
      timeout_milliseconds := 60000
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.pulse_cron_fire_reminders() from public, anon, authenticated;

-- ══ 3. cron 登録（未登録の時だけ・毎日 09:00 JST = 00:00 UTC） ═══════
select cron.schedule(
  'pulse-reminders',
  '0 0 * * *',
  $cron$select public.pulse_cron_fire_reminders()$cron$
)
where not exists (
  select 1 from cron.job where jobname = 'pulse-reminders'
);

commit;
