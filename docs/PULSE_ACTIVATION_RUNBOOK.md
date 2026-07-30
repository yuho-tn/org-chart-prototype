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

## ④ pg_cron 登録SQL（任意・締切前リマインドの自動化）

①-1-5 で `PULSE_CRON_SECRET` を投入済みであることが前提。
Supabase ダッシュボード → **SQL Editor** で以下を実行（`<CRON_SECRET>` は①-1-5で生成した値に置換）。

```sql
-- 拡張（未有効なら）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 毎日 09:00 JST(=00:00 UTC) に、締切2日前以内の sent サイクルへリマインド
select cron.schedule(
  'pulse-due-reminders',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<CRON_SECRET>'
    ),
    body := jsonb_build_object('cycle_id', c.id::text, 'mode', 'reminder')
  )
  from public.pulse_cycles c
  where c.status = 'sent'
    and c.due_date is not null
    and c.due_date >= current_date
    and c.due_date <= current_date + interval '2 days'
  $$
);
```

解除したくなったら:

```sql
select cron.unschedule('pulse-due-reminders');
```

登録済みcron一覧の確認:

```sql
select jobname, schedule, active from cron.job where jobname = 'pulse-due-reminders';
```

---

## ⑤ 管理画面での運用開始操作

①〜③（④は任意）が終わったら、あとは https://shosan-talent-hub.vercel.app の
**#/pulse/admin** で以下を順番に操作する（各ステップはダッシュボード上部の
運用ステッパーにも同じ4段階で表示される）。

### 5-1. 設問セットの最終編集 → 有効化

1. #/pulse/admin → 設問セット一覧から「月次パルスサーベイ v1」（draft）を開く
2. 天気4問（仕事／対人／健康／評価）＋ eNPS 1問 ＋ 自由記述1問の文言を確認・必要なら編集
3. 「有効化」ボタン → 確認ダイアログ「有効化後は設問を編集できません（修正は複製→新版）」
   が出るので内容を確認して確定

> **有効化すると設問は凍結される**（後で文言を直したい場合は複製して新版を作り、
> 新版を編集→有効化する運用になる）。

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
