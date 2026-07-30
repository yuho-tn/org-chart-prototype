# パルスサーベイ Edge Function / 配信 プロビジョニング手順

スライス6（Claude要約）・スライス7（Slack/メール配信＋リマインド）を動かすための
外部設定手順（技術リファレンス）。**すべて裕鵬さんのコンソール操作が必要**（トークン発行・
課金判断を伴うため）。

> 裕鵬さん向けに手順だけをコピペで踏める順序でまとめたものは
> `docs/PULSE_ACTIVATION_RUNBOOK.md` を参照。本ファイルは各コマンド・各手順の
> 技術的な背景（何のための secret か・Edge Function の挙動）を残す技術リファレンス。

## 現状（2026-07-31 時点）

- Edge Function `pulse-summary` / `pulse-notify` は **デプロイ済み**（P4-⑤・0032本番活性化と
  同時に実施。以後コード変更時は §0 のコマンドで再デプロイ）。
- migration **0032 は適用済み**（`supabase/manual/` からの隔離は解除され
  `supabase/migrations/0032_pulse_production_activation.sql` として本番に反映済み）。
  テストデータは掃除済み・「月次パルスサーベイ v1」設問セットが draft で seed されている。
- secrets（ANTHROPIC_API_KEY / SLACK_BOT_TOKEN / RESEND_API_KEY 等）は**未投入**。
  投入するまで #/pulse の「AI要約を生成」「一斉送信」「リマインド」は動かない
  （pulse-notify は 0045 で secrets 未設定時に `no_channel_configured` エラーを明示的に返すよう
  修正済み＝サイレント no-op ではなくなった）。
- 有効な設問セット・サイクルは未作成（設問文言の最終編集・有効化・サイクル作成・受付開始・
  一斉送信は裕鵬さんの操作＝#/pulse/admin）。

→ 残タスクは secrets 投入 と #/pulse/admin での運用開始操作のみ。
  実行順序は `docs/PULSE_ACTIVATION_RUNBOOK.md` に従う。

---

## 0. 前提：Edge Function のデプロイ（6・7共通・コード変更時のみ再実行）

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

→ これで #/pulse ダッシュボードの「AI要約を生成」が動く。未設定のままだと
「APIキー未設定です。docs/PULSE_ACTIVATION_RUNBOOK.md 参照」とダッシュボードに表示される。

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
   Slack / メールどちらか片方の secret だけでも、設定されているチャネルだけ送信・もう片方はスキップ。
   **両方とも未設定のまま呼び出すと、pulse-notify は HTTP 400 `{ error: "no_channel_configured" }`
   を返す**（0045 で追加。以前はここが黙って0件送信のサイレント no-op になっていた）。
   #/pulse/admin 側はこのエラーを検知すると「配信チャネル未設定（Runbook参照）。回答URLを
   手動でSlack投稿してください」＋「回答URLをコピー」ボタンを表示する。

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
  secrets が両方未設定なら「配信チャネル未設定」エラー表示になることを確認。

---

## 5. 運用開始（本番活性化）— 現在地と残タスク

**migration 0029〜0032（メンバー推移 / eNPS / 面談ログ / テストデータ掃除＋初期設問seed）は
適用済み。** 以下は完了済み・残タスクの棚卸し（コピペ手順は `docs/PULSE_ACTIVATION_RUNBOOK.md`）。

- [x] 0029〜0032 適用（テストデータ一掃・「月次パルスサーベイ v1」draft seed 済み）
- [x] Edge Function `pulse-summary` / `pulse-notify` デプロイ済み
- [x] 0045（本ハードニング）で `pulse-notify` の `no_channel_configured` 明示化・
      集計/コメントの n<5 マスク強化・`pulse_my_history` / `pulse_admin_cycle_stats` 追加
- [ ] secrets 投入（§1〜2. ANTHROPIC_API_KEY / SLACK_BOT_TOKEN / RESEND_API_KEY / RESEND_FROM / PULSE_APP_URL）
- [ ] #/pulse/admin で「月次パルスサーベイ v1」の設問文言を最終編集 → **有効化**
      （有効化後は設問凍結。修正は「複製で新版」→ 編集 → 有効化）
- [ ] サイクル作成（period=開始月・締切日設定）→「受付開始」
- [ ] 「一斉送信」ボタン（Slack DM＋メールのダブル配信・初回は裕鵬さん1クリック承認）
- [ ] （任意）§3 の pg_cron で締切前リマインド自動化
- [ ] 1サイクル通し確認: 配信 → 回答（#/survey・eNPS 0-10・マイパルス表示含む）→ 集計
      → アラート → メンバー推移 → AI要約 → CSV
