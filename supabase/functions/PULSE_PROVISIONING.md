# パルスサーベイ Edge Function / 配信 プロビジョニング手順

スライス6（Claude要約）・スライス7（Slack/メール配信＋リマインド）を本番で動かすための
外部設定手順。**すべて裕鵬さんのコンソール操作が必要**（トークン発行・課金判断を伴うため）。

---

## 0. 前提：Edge Function のデプロイ（6・7共通）

```bash
cd ~/projects/active/meta/org-chart-prototype
supabase functions deploy pulse-summary --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-notify  --project-ref kgofrmfsfnxbzqkfrkqo
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は自動注入される。

---

## 1. スライス6（Claude要約）: ANTHROPIC_API_KEY

鍵は `~/.config/aibrain/token.env` の `ANTHROPIC_API_KEY` を流用。

```bash
# 値はエコーせず env から直接投入
source ~/.config/aibrain/token.env
supabase secrets set ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" --project-ref kgofrmfsfnxbzqkfrkqo
```

→ これで #/pulse ダッシュボードの「AI要約を生成」が動く。

---

## 2. スライス7（配信）: Slack Bot ＋ Resend

### 2-1. Slack Bot（SHO-SAN ワークスペースにアプリ登録）
1. https://api.slack.com/apps → **Create New App** → From scratch → SHO-SAN ワークスペース選択
2. **OAuth & Permissions** → Bot Token Scopes に `chat:write` と `users:read.email` を追加
3. **Install to Workspace** → `xoxb-...` Bot User OAuth Token を取得
4. secret 投入:
   ```bash
   supabase secrets set SLACK_BOT_TOKEN="xoxb-..." --project-ref kgofrmfsfnxbzqkfrkqo
   ```
   ※ Bot が DM を送るには対象ユーザーと同一ワークスペースであればよい（招待不要）。

### 2-2. メール（Resend 推奨）
1. https://resend.com にサインアップ → API Key 発行（`re_...`）
2. 独自ドメインを Verify（SPF/DKIM）。未検証なら `onboarding@resend.dev` で送信テストのみ可
3. secret 投入:
   ```bash
   supabase secrets set RESEND_API_KEY="re_..." --project-ref kgofrmfsfnxbzqkfrkqo
   supabase secrets set RESEND_FROM="TalentHub <pulse@forumyu.co.jp>" --project-ref kgofrmfsfnxbzqkfrkqo
   ```

### 2-3. アプリ URL（回答リンク）
```bash
supabase secrets set PULSE_APP_URL="https://shosan-talent-hub.vercel.app" --project-ref kgofrmfsfnxbzqkfrkqo
```

→ 設定後、#/pulse/admin の「一斉送信」「リマインド」ボタンが動く（初回一斉は裕鵬1クリック承認＝グリル決定⑧）。
   Slack / メールどちらかの secret だけでも、あるチャネルのみ送信・他はスキップ。

---

## 3. 締切前リマインドの自動化（pg_cron・任意）

自動リマインドは pg_cron ＋ pg_net で pulse-notify を叩く。**secret を含むため手動で1回実行**
（このSQLはリポにコミットしない。値を差し込んで Supabase SQL Editor で実行）。

```sql
-- 拡張（未有効なら）
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 共有シークレット（cron からの起動を認可）
-- 1) ランダム値を1つ決めて Edge Function 側にも入れる:
--    supabase secrets set PULSE_CRON_SECRET="<ランダム32桁>" --project-ref kgofrmfsfnxbzqkfrkqo
-- 2) 下の <CRON_SECRET> と <FUNCTIONS_URL> を実値に置換して実行:

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

-- 解除: select cron.unschedule('pulse-due-reminders');
```

---

## 4. 動作確認

- 6: #/pulse →「AI要約を生成」→ 要約が表示されれば OK
- 7: #/pulse/admin → sent サイクルの「一斉送信」→ 応答 `counts` で slack_ok / email_ok を確認、
  Slack DM とメール受信を実機確認。`pulse_notifications` に記録が入る。
