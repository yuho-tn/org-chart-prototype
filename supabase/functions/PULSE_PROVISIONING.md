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
supabase functions deploy pulse-answer  --project-ref kgofrmfsfnxbzqkfrkqo
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は自動注入される
（2026-09-20 実測: Runtime に注入される値は `sb_publishable_…` / `sb_secret_…` 形式。
CLI `projects api-keys` の legacy JWT とは別物なので、ローカルで同じ鍵を再現しようとしない）。

**verify_jwt は `supabase/config.toml` で関数ごとに固定している（2026-09-20 追加）**:
`pulse-answer` / `pulse-notify` / `smarthr-sync` / `employees-export` = false、`pulse-summary` = true。
`functions deploy` は config.toml の値を使うので、フラグを毎回付ける必要はない
（以前は `--no-verify-jwt` を手で付ける運用で、付け忘れた再デプロイ1回で
「トークン回答・cron リマインドが黙って全滅」する構造だった＝独立レビュー指摘）。
デプロイ後は `supabase functions list --project-ref kgofrmfsfnxbzqkfrkqo` で verify_jwt を必ず目視する。

- `pulse-answer`: `#/survey?t=<token>`（ログイン不要の本人専用URL）からの回答を受ける。認可は
  Authorization ヘッダ（ゲートウェイの JWT 検証）ではなく本人専用トークン（`_shared/pulseToken.ts`）だけ。
  verify_jwt=true になると（Authorization を送らない）トークン経由のリクエストが全て弾かれ、回答が全滅する。
- `pulse-notify`: pg_cron（0050 `pulse_cron_fire_reminders`）が `x-cron-secret` ヘッダだけで呼ぶ
  （JWT を持たない）。verify_jwt=true になるとゲートウェイの 401 で自動リマインドが黙って全滅する
  （`cron.job_run_details` は succeeded のまま・失敗は `net._http_response` にしか残らない）。
  保険として Vault に `pulse_anon_key`（公開 anon key）を入れておくと 0050 が Authorization も付ける（任意）。

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

**n<5 マスク（v3 P1・`pulse-summary`）**: 当サイクルの回答者数（`pulse_responses` 件数）が
5 未満の場合、自由記述コメントの本文は Anthropic へ一切渡さない（`context.comments = []`
＋ `context.comments_note` を付与）。少人数だと文体だけで個人が推定され得るための保護で、
`pulse_summaries.meta.comments_masked` に true/false を記録する。部署別集計（`by_department`）
側の n<5 除外（`pulse_compute_aggregates` 由来の `masked` フラグ）はこれとは別に既存のまま維持。

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
   手動でSlack投稿してください」＋「回答URLをコピー」ボタンを表示する（v3以降は「自分用URL」＝
   後述の preview モードの `my_url` に置き換わる）。

### 2-4. 本人専用トークン URL の署名鍵（PULSE_TOKEN_SECRET・**必須**・v3 P1）

v3 から配信メッセージの `{url}` は `#/survey?t=<token>`（ログイン不要・本人専用URL）になる。
`token` の署名鍵は `_shared/pulseToken.ts` が **専用 secret `PULSE_TOKEN_SECRET` だけ**から派生する
（`K = HMAC-SHA256(key=PULSE_TOKEN_SECRET, msg="talenthub-pulse-answer-v1")`）。

```bash
openssl rand -hex 32
supabase secrets set PULSE_TOKEN_SECRET="<↑で出た値>" --project-ref kgofrmfsfnxbzqkfrkqo
```

未投入のときは `pulse-answer`／`pulse-notify`（preview 含む）が HTTP 500
`{ error: "token_secret_not_configured" }` を返し、管理画面に「PULSE_TOKEN_SECRET が未設定です」と出る
（黙って invalid_token にはしない）。

**なぜ専用 secret を必須にしたか（2026-09-20 実測）**: 当初は `SUPABASE_SERVICE_ROLE_KEY` への
フォールバックを持たせていたが、Edge Runtime が注入する `SUPABASE_SERVICE_ROLE_KEY` は
プラットフォーム都合で値が変わる（legacy JWT → `sb_secret_…` へ切り替わっていた。CLI の
`projects api-keys` からはその値を確認できない）。その鍵に依存すると配布済みURLが月の途中で
黙って全滅し得るため、自分たちで管理する用途専用の secret だけを材料にする。

**変更のタイミングに注意（重要）**: 値を変えると過去に発行した全トークンの署名検証が失敗する
（配布済みURLが軒並み `invalid_token`）。
- **初回の一斉送信より前に一度だけ決めて固定する。**
- **一斉送信・リマインドを送った後に変更しない**（変更するなら当該サイクルを締め切ってから、
  次サイクルの配信前に行う）。

### v3（P0/P1・本人専用トークンURL）残タスク

- [ ] migration `0049_pulse_v3_p1.sql` / `0050_pulse_reminder_cron.sql` 適用（backend 担当分。
      `pulse_settings` / `pulse_target_exclusions` / `pulse_survey_bundle_for` 等・PULSE_V3_DESIGN.md §3）
- [ ] Edge Function 3本を §0 のコマンドで（再）デプロイ：`pulse-summary` / `pulse-notify` /
      **`pulse-answer`（verify_jwt=false・config.toml で固定）**
- [ ] `PULSE_TOKEN_SECRET` を投入する（§2-4・必須）。**初回一斉送信より前**に固定
- [ ] §3 の手動 pg_cron（`'pulse-due-reminders'`）を使っていた場合は 0050 適用前に unschedule
- [ ] フロント（`src/`）が `pulse_survey_bundle_for` / `pulse_submit_response_for` 等の v3 RPC・
      `#/survey?t=` ルーティングに対応済みであること（frontend 担当分・別スレッド）
- [ ] §4 の preview モード確認 → 一斉送信 → `#/survey?t=<token>` をログアウト状態で開いて回答 →
      前回比較・振り返り（`#/survey/history`）まで通し確認
