# パルスサーベイ 本番活性化ランブック（裕鵬さん向け）

対象: TalentHub パルスサーベイ（#/survey・#/pulse）を「明日から実運用」に上げるための
残タスクをコピペで踏める順に並べたもの。DB migration（0021〜0032・0045）とEdge Function
（`pulse-summary` / `pulse-notify`）のデプロイは完了済み。ここから先はすべて裕鵬さんの
コンソール操作（トークン発行・課金判断を伴うため他者に委譲できない）。

実行先: Supabase project ref `kgofrmfsfnxbzqkfrkqo`（= `.env.local` の `VITE_SUPABASE_URL`）。
所要時間の目安: secrets投入 15分／Slack App作成 10分／Resend登録 10分／
pg_cron（任意）5分／管理画面操作 5分。

技術的な背景（各secretの意味・Edge Functionの挙動）は
`supabase/functions/PULSE_PROVISIONING.md` を参照。本ファイルは手順のみ。

---

## ① secrets 6種の投入

先に鍵・トークンを揃えてから、まとめて投入する。

### 1-1. ANTHROPIC_API_KEY（AI要約用・既存の鍵を流用）

```bash
cd ~/projects/active/meta/org-chart-prototype
source ~/.config/aibrain/token.env
supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --project-ref kgofrmfsfnxbzqkfrkqo
```

### 1-2. SLACK_BOT_TOKEN（②で取得した `xoxb-...` を貼る）

```bash
supabase secrets set SLACK_BOT_TOKEN="xoxb-ここに貼る" --project-ref kgofrmfsfnxbzqkfrkqo
```

### 1-3. RESEND_API_KEY ／ RESEND_FROM（③で取得）

```bash
supabase secrets set RESEND_API_KEY="re_ここに貼る" --project-ref kgofrmfsfnxbzqkfrkqo
supabase secrets set RESEND_FROM="TalentHub <pulse@forumyu.co.jp>" --project-ref kgofrmfsfnxbzqkfrkqo
```

独自ドメインを未検証のまま試したい場合は `RESEND_FROM="TalentHub <onboarding@resend.dev>"` で送信テストのみ可。

### 1-4. PULSE_APP_URL（回答リンクの基底URL・固定値）

```bash
supabase secrets set PULSE_APP_URL="https://shosan-talent-hub.vercel.app" --project-ref kgofrmfsfnxbzqkfrkqo
```

### 1-5. PULSE_CRON_SECRET（④の pg_cron 自動リマインドを使う場合のみ）

```bash
# ランダム32桁を生成して投入（このターミナル出力の値を④のSQLでも使う）
openssl rand -hex 16
supabase secrets set PULSE_CRON_SECRET="<↑で出た値>" --project-ref kgofrmfsfnxbzqkfrkqo
```

### 確認

```bash
supabase secrets list --project-ref kgofrmfsfnxbzqkfrkqo
```

6つとも一覧に出ていればOK。値そのものは表示されない（ハッシュのみ）。

---

## ② Slack App 作成手順

1. https://api.slack.com/apps を開く → **Create New App** → **From scratch**
2. App名は任意（例: `TalentHub Pulse`）→ ワークスペースは **SHO-SAN** を選択
3. 左メニュー **OAuth & Permissions** を開く
4. **Scopes → Bot Token Scopes** に以下2つを追加:
   - `chat:write`
   - `users:read.email`
5. ページ上部の **Install to Workspace** をクリック → 権限確認画面で許可
6. 発行された **Bot User OAuth Token**（`xoxb-` で始まる文字列）をコピー
   → ①-1-2 の `SLACK_BOT_TOKEN` として投入
7. 招待は不要（Bot は `users.lookupByEmail` で対象社員をメールアドレスから解決し、
   同一ワークスペース内であれば直接DMを送れる）

---

## ③ Resend 登録手順

1. https://resend.com にアクセスしてサインアップ
2. ダッシュボード → **API Keys** → 新規キー発行（`re_` で始まる文字列）
   → ①-1-3 の `RESEND_API_KEY` として投入
3. 独自ドメイン（例: `forumyu.co.jp`）を **Domains** から追加し、表示される SPF/DKIM の
   DNS レコードをドメイン管理画面（お名前.com等）に設定 → Verify 完了を待つ
   （検証に数時間かかる場合あり。急ぐ場合は `onboarding@resend.dev` で送信元を代用可＝
   ただし到達率・ブランディングは劣る）
4. Verify 完了後、`RESEND_FROM` を検証済みドメインのアドレスに設定（①-1-3参照）

---

## ④ pg_cron リマインド自動化（Vault へ secret を投入するだけ）

`0050_pulse_reminder_cron.sql` の適用（`supabase db push`）で pg_cron ジョブ
`pulse-reminders`（毎日 09:00 JST = 00:00 UTC・営業日ベースで2営業日おき×最大4回
リマインド＝決定9）は**自動登録済み**。pg_cron / pg_net 拡張の有効化・
`pulse_cron_due_cycles()` / `pulse_cron_fire_reminders()` の作成・cron 登録は
すべて migration 内で完結する（このセクションでSQLを手打ちする必要はない）。

有効化に必要な作業は、①-1-5 で生成した `PULSE_CRON_SECRET` と**同じ値**を
Supabase Vault へ入れる、この1回だけ。Supabase ダッシュボード → **SQL Editor** で:

```sql
select vault.create_secret('<①-1-5で生成した値と同じもの>', 'pulse_cron_secret');
-- 任意（保険）: 公開 anon key を入れておくと、pulse-notify が誤って verify_jwt=true で
-- 再デプロイされてもゲートウェイの 401 にならない（値は Settings → API の anon key）
select vault.create_secret('<anon key>', 'pulse_anon_key');
```

secret が未投入の間は `pulse_cron_fire_reminders()` が何もせず `0` を返すだけ
（migration 自体・cron 自体は secrets 未投入でも安全に動く＝休眠状態）。

> ⚠️ pulse-notify は **verify_jwt=false**（デプロイ時に `--no-verify-jwt`）で運用する。
> cron は JWT を持たず `x-cron-secret` だけで呼ぶため、verify_jwt=true に戻すと
> `cron.job_run_details` は succeeded のまま自動リマインドが全滅する（下の `net._http_response` で気づく）。

### 確認

```sql
-- 今日リマインド対象のサイクル（dry-run。実際には発火しない）
select * from public.pulse_cron_due_cycles();

-- cron 登録状況
select jobname, schedule, active from cron.job where jobname = 'pulse-reminders';

-- 直近の実行結果（実行後・Vault投入後の翌日以降に意味を持つ）
select * from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'pulse-reminders')
order by start_time desc limit 5;

-- pulse-notify が実際に何を返したか（cron 側が succeeded でも HTTP は失敗し得る。
-- status_code 200 以外＝要調査。401 なら verify_jwt / x-cron-secret の不一致）
select id, status_code, left(content::text, 200) as body, created
from net._http_response order by created desc limit 5;

-- secret が入っているかだけを確認（値そのものは表示しない）
select exists (
  select 1 from vault.decrypted_secrets where name = 'pulse_cron_secret'
) as pulse_cron_secret_set;
```

解除したくなったら:

```sql
select cron.unschedule('pulse-reminders');
```

---

## ⑤ 管理画面での運用開始操作

①〜③（④は任意）が終わったら、あとは https://shosan-talent-hub.vercel.app の
**#/pulse/admin** で以下を順番に操作する（各ステップはダッシュボード上部の
運用ステッパーにも同じ4段階で表示される）。

### 5-1. 設問セット（有効化済・確認のみ）

**月次パルスサーベイ v1**（天気4問〔仕事／対人／健康／評価〕＋ eNPS 1問 ＋
自由記述1問）は **2026-07-31 に有効化済**（設問は凍結済み）。#/pulse/admin の
設問セット一覧で status=active を確認できる。このステップで新たに操作することはない。

> **文言を変更したい場合**は複製 → 新版（draft）を編集 → 新版を「有効化」する運用
> （有効化済みの設問セットは直接編集できない）。新版を active にすると、以後の
> サイクル作成で選べる設問セットも新版に切り替わる（旧版は archived のまま残る）。

### 5-2. サイクル作成 → 受付開始

1. 「サイクルを作成」→ 対象月（`type="month"` 入力）と締切日を設定 → 有効化済みの
   設問セットを選択して保存（status: `scheduled`）
2. 一覧の該当行から「受付開始」→ status が `sent` に変わる
   （**この時点ではまだ誰にも通知は飛ばない** — 通知は次の5-3で行う正フロー）

### 5-3. 一斉送信

1. 受付中サイクルの行（またはダッシュボードのヒーローバー）から「一斉送信」をクリック
2. 初回は裕鵬さんの1クリック承認として扱われる。Slack DM とメールへダブルで配信され、
   結果（`targets` / slack成功 / メール成功 / skip）がトーストと行内に表示される
3. secrets が未投入だと「配信チャネル未設定（Runbook参照）。回答URLを手動でSlack投稿して
   ください」＋「回答URLをコピー」ボタンが出る → その場合は①に戻って secrets を投入してから
   やり直すか、コピーしたURLを手動でSlack投稿して当面をしのぐ

### 5-4. 通し確認

配信 → 回答（#/survey・eNPS 0-10・送信後の「マイパルス」表示）→ #/pulse の自動集計・
指標カード・チャート → #/pulse/alerts のアラート → #/pulse/comments のコメント →
#/pulse/members のメンバー推移 → AI要約 → CSV出力、の一連が通ることを1サイクル分確認する。

---

## トラブルシュート

| 症状 | 原因 | 対処 |
|---|---|---|
| 「一斉送信」が `no_channel_configured` エラー | SLACK_BOT_TOKEN / RESEND_API_KEY が両方未設定 | ①・②・③を実施してから再試行 |
| AI要約ボタンが「APIキー未設定です」 | ANTHROPIC_API_KEY 未設定 | ①-1-1を実施 |
| Slack DM が届かない | Bot Token の scope不足 / 対象者のメールがSlackアカウントと不一致 | ②のscope（`chat:write`,`users:read.email`）を確認。`employees.email` の値がSlackログインメールと一致しているか確認 |
| メールが届かない（Resendの未検証ドメイン） | ドメイン未Verify | ③-3のDNS設定を確認、または `onboarding@resend.dev` で暫定運用 |
| pg_cronが動いているか不安 | — | ④末尾の確認SQLで `active = true` を確認。`cron.job_run_details` で直近実行結果も見られる |

---

## ⑥ 対象者ルールの設定（雇用形態・個別除外）

配信対象・対象人数（`pulse_target_count()`）は `pulse_settings.target_employment_types`
（対象とする雇用形態の配列）と `pulse_target_exclusions`（個別除外）の2つで決まる。
P0時点の既定値は「正社員・限定正社員」（`docs/PULSE_V3_DESIGN.md` §1 の実測に基づく推定値。
Geppo対象66名 ≒ 正社員＋限定正社員−執行役員3名という概算で、確定にはGeppo名簿CSVとの
突合が必要）。専用のUIはまだ無いため（P3で追加予定）、Supabase ダッシュボード →
**SQL Editor** で直接操作する。

### 対象の雇用形態を確認・変更する

```sql
-- 現在の設定を確認
select target_employment_types from public.pulse_settings where id = 1;

-- 変更する（例: 契約社員も対象に加える）
update public.pulse_settings
set target_employment_types = array['正社員','限定正社員','契約社員']
where id = 1;

-- 変更後の対象人数を確認
select public.pulse_target_count();
```

### 特定の社員を個別に対象から除外する

```sql
-- 除外を追加（employee_number は employees.employee_number。既存なら reason を上書き）
insert into public.pulse_target_exclusions (employee_number, reason, created_by_email)
values ('10018', '休職中', 'yuho_tn@sho-san.co.jp')
on conflict (employee_number) do update
  set reason = excluded.reason, created_by_email = excluded.created_by_email;

-- 除外を解除
delete from public.pulse_target_exclusions where employee_number = '10018';

-- 現在の除外一覧
select * from public.pulse_target_exclusions order by created_at desc;
```

### 特定の社員が対象かどうかを確認する

```sql
select public.pulse_is_target('10018');
```
