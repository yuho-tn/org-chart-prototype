# SmartHR 同期アラート 有効化ランブック（migration 0054 / Edge Function `smarthr-alert`）

**状態：未デプロイ。**本番反映（`supabase functions deploy` / migration 適用）は裕鵬さんの承認後に実施する。

---

## なぜ作ったか

2026-09-23、SmartHR 側のサブドメイン改称（`sho-san20220722mk` → `sho-san`）で日次同期が
`400 {"message":"subdomain ... is inactive"}` を返し続けていた。失敗は `smarthr_sync_state.last_status`
に書かれるだけで、画面では従業員マスターのヘッダに出る「最終同期」チップの先頭に小さな ⚠ が付くのみ。
誰も見ておらず、**発見時には従業員マスターが7件ズレていた（入社3名が未反映・退職4名が在籍のまま）**。

失敗が記録されていたのに誰にも届かなかった、が事故の本体。ここを塞ぐ。

## 何を検知するか

| state | 条件 | なぜ要るか |
|---|---|---|
| `error` | 直近の同期が失敗 | 今回の改称事故・トークン失効 |
| `stale` | 成功しているが `last_run_at` が **36時間**動いていない | **cron・Vault secret・関数自体が死ぬと `last_status` は最後の `'ok'` のまま固まる。`error` 監視だけでは永久に気づけない**（今回と同型の穴） |
| `never` | 一度も実行されていない | 新環境での配線忘れ |

判定は `smarthr_sync_health()` 1本に集約してある。**画面のバッジと Slack 通知が同じ関数を読む**
（条件を2か所に書くと必ず食い違うため）。

## 通知の間引き

- 同じ原因は **1日1回**まで（`p_repeat_hours` 既定 20h。日次 cron の 24h より短くしてある＝
  24h にすると経過時間の僅差で判定を外し、通知が1日おきになる）
- **原因が変わったら抑止期間内でも即通知**（改称 → トークン失効、など）
- **復旧時に1回だけ「復旧しました」**を送る（直したのに追いかける人を出さない）
- 1人も送信に成功しなかった場合は通知済みにしない＝次回また試す
- 宛先ゼロの場合も通知済みにしない（誰にも届いていないのに沈黙させない）

## 宛先

既定は `app_users` の **master / privileged_admin / admin**（＝`smarthr_can_sync()` と同じ
「同期を直せる人」の集合）。明示指定したい場合のみ:

```sql
update public.smarthr_sync_state
   set alert_recipients = array['yuho_tn@sho-san.co.jp','hr@sho-san.co.jp']
 where id;
```

`null` か空配列に戻すと既定（ロール基準）へ戻る。止めたい時は `alert_enabled = false`。

---

## 有効化手順（承認後）

### ① migration 適用

```bash
supabase db push
```

> ⚠️ 採番は **0054**。当初 0052 → 0053 → 0054 と二度振り直している。
> 本番の migration 履歴は 0052=`user_admin_containment`（2026-09-23 適用）、
> 0053=`profile_notion_fields`（別セッションが適用）で埋まっており、
> **重複した番号は `db push` で「適用済み」と判定されて黙ってスキップされる**
> （＝通知機能が有効化されないまま気づけない）。`db push` 前に
> `select * from supabase_migrations.schema_migrations order by version desc limit 5;` で
> 0053 までが入っていることを必ず確認すること。
>
> ⚠️ `db push` は**チェックアウト中のブランチの migrations を見る**。必ず main
> （もしくは main ベースの本ブランチ）から実行し、`--dry-run` で対象が
> `0054_smarthr_sync_alert.sql` だけであることを確認してから打つこと。

### ② cron 用 secret を Vault へ投入

`smarthr-sync` が使っている `SMARTHR_CRON_SECRET` と**同じ値**を Vault に入れる
（未投入のあいだ `smarthr_cron_fire_sync_alert()` は何もせず 0 を返す＝安全に空振りする）。

```sql
select vault.create_secret('<SMARTHR_CRON_SECRET と同じ値>', 'smarthr_cron_secret');
```

### ③ Edge Function をデプロイ

```bash
supabase functions deploy smarthr-alert
```

`verify_jwt=false` は `supabase/config.toml` で固定済み（フラグの付け忘れで cron 起動が
黙って全滅するのを防ぐため）。

### ④ 送信せずに文面を確認（preview）

```bash
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/smarthr-alert" \
  -H "Authorization: Bearer <管理者のJWT>" \
  -H "Content-Type: application/json" \
  -d '{"mode":"preview"}' | python3 -m json.tool
```

`would_send` / `recipients` / `text` が返る。**送信も記録も一切しない。**

### ⑤ 実送信のテスト

```bash
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/smarthr-alert" \
  -H "x-cron-secret: <SMARTHR_CRON_SECRET>" \
  -H "Content-Type: application/json" -d '{"mode":"check"}'
```

同期が正常なら `{"ok":true,"sent":0,"skipped":"nothing_to_report","state":"ok"}` が返る（正しい挙動）。
異常を1回だけ再現したい時は、テスト後に必ず戻すこと:

```sql
-- 直前の値を控えてから
update public.smarthr_sync_state set last_run_at = now() - interval '40 hours' where id;
-- → check を叩いて Slack DM を確認 → 戻す
update public.smarthr_sync_state set last_run_at = now(), last_alert_key = null where id;
```

---

## ⚠️ 併せて確認が必要（本 migration の対象外）

**日次同期そのものの cron ジョブが、どの migration にも入っていない。** 手で登録されたまま
バージョン管理外にある＝レビューもされず、消えても誰も気づかない。実体を確認すること:

```sql
select jobid, jobname, schedule, command, active from cron.job;
select jobname, status, return_message, start_time
  from cron.job_run_details order by start_time desc limit 20;
```

登録が無い／壊れている場合は、`smarthr-sync` を叩く cron を **migration として** 追加する
（今回の 0054 は「壊れたことに気づく」仕組みであって、同期を動かす仕組みではない。
stale 検知は同期 cron が死んでいれば鳴るが、鳴らす側の cron が別に要る）。

この 2本目の cron は、本タスクの範囲（失敗通知）を越えるため今回は触っていない。
上のクエリ結果を見て判断したい。
