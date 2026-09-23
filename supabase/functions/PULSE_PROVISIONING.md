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
# P2（2026-09-21 追加・§3参照）
supabase functions deploy pulse-alert-digest     --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-comment-classify --project-ref kgofrmfsfnxbzqkfrkqo
```

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は自動注入される
（2026-09-20 実測: Runtime に注入される値は `sb_publishable_…` / `sb_secret_…` 形式。
CLI `projects api-keys` の legacy JWT とは別物なので、ローカルで同じ鍵を再現しようとしない）。

**verify_jwt は `supabase/config.toml` で関数ごとに固定している（2026-09-20 追加）**:
`pulse-answer` / `pulse-notify` / `smarthr-sync` / `employees-export` / `pulse-alert-digest`
（2026-09-21 追加）/ `pulse-comment-classify`（2026-09-21 追加）= false、`pulse-summary` = true。
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

---

## 3. P2 アラート通知・分類（Edge `pulse-alert-digest` / `pulse-comment-classify`）

PULSE_V3_DESIGN.md §10-6 の実装（branch `feat/pulse-v3-p2`）。**新規 secret は無い**＝
§1 の `ANTHROPIC_API_KEY`・§2-1 の `SLACK_BOT_TOKEN`・§2-3 の `PULSE_APP_URL`・
pulse-notify と共用の `PULSE_CRON_SECRET` をそのまま再利用する。

### 3-1. デプロイ

§0 のコマンドに含まれている（`pulse-alert-digest` / `pulse-comment-classify`）。
verify_jwt は両方とも `false`（config.toml で固定・§0 と同じ理由＝cron が `x-cron-secret` の
みで呼ぶため。誤って `--no-verify-jwt` を外して再デプロイすると cron 経由の日次ダイジェスト・
即時通知・分類バッチが黙って全滅する＝ pulse-notify と同型のリスク）。

### 3-2. 何をする関数か

- **`pulse-comment-classify`**: 自由記述コメントを Claude（`claude-sonnet-5`）で固定11分類
  （SOS／体調不安／人間関係／仕事／評価／キャリア／プライベート／総務／要望・提言／組織課題／
  分類困難）に分類し `pulse_comment_classifications` へ保存する。保存の副作用として本人×当サイクルの
  アラート再判定（`pulse__evaluate_employee`）も内部で走る。
  - `POST { "response_id": "<uuid>" }` … 指定1件だけ。分類済みで本文（comment_hash）が変わって
    いなければ何もせず `{ok:true, classified:0, ...}` を返す。
  - `POST { "mode": "batch", "limit"?: number }` … 未分類の取りこぼしをまとめて処理（既定 limit=50・
    上限200）。daily ダイジェスト実行時に毎回1回呼ばれる（下記）ほか、手動でも叩ける。
  - Claude へ送るのはコメント本文＋天気4値＋eNPSのみ。氏名・社員番号・部署は一切渡さない
    （`pulse_pending_classifications` RPC 自体がそれらを返さない設計＝§10-4 の n<5 作法）。
- **`pulse-alert-digest`**: 人事管理者（`pulse_settings.alert_digest_recipients`）へ Slack DM で
  アラートを届ける。**上長には一切通知しない**（決定5）。
  - `POST { "mode": "daily" }` … 毎日 **09:10 JST** に pg_cron（`pulse_cron_fire_alert_digest`・
    migration 0051）が x-cron-secret 付きで自動起動。①`pulse-comment-classify` をバッチ起動（分類の
    取りこぼし追い付き）→②当月 sent サイクルへルール再判定→③未通知（open かつ notified_at is null）
    アラートを集計→④本文を組む→⑤Slack DM→⑥送れたら通知済みにマーク。
  - `POST { "mode": "immediate", "alert_ids": ["<uuid>", …] }` … SOS／体調不安等
    `notify_immediately=true` のルールに新規該当した瞬間、DB内部関数 `pulse__request_immediate`
    （migration 0051）が x-cron-secret 付きで自動起動する。`alert_ids` 必須（省略時は 400）。
  - `POST { "mode": "preview" }` … 送信・マークなし。分類バッチ起動やルール再判定も行わない
    （副作用ゼロ）。今ダイジェストを送るとどんな本文になるかだけを返す（JWTのみ・cron起動不可。
    §10-8 の「ダイジェストを確認」ボタンから叩く想定。「今すぐ送る」ボタンは daily を叩く）。

### 3-3. 手動実行の curl 例

裕鵬さんのログイン済みブラウザから取れる Supabase JWT を `$JWT` に、pulse-notify と共用の
cron secret を `$CRON` に入れて叩く（#/pulse/admin のボタンが使えない時の代替経路）。

```bash
# 今送るとどうなるか確認（プレビュー・副作用なし）
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-alert-digest" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"mode":"preview"}' | jq .

# 日次ダイジェストを手動で今すぐ送る（#/pulse/admin「今すぐ送る」と同じ経路）
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-alert-digest" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"mode":"daily"}' | jq .

# cron 側と同じ叩き方（x-cron-secret。本番運用と同一経路の動作確認用）
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-alert-digest" \
  -H "x-cron-secret: $CRON" -H "Content-Type: application/json" \
  -d '{"mode":"daily"}' | jq .

# コメント分類の取りこぼしを手動で追い付かせる
curl -s -X POST "https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-comment-classify" \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"mode":"batch"}' | jq .
```

### 3-4. 失敗時の見え方

| 症状 | 原因 | 対処 |
|---|---|---|
| `{"error":"anthropic_not_configured"}`（pulse-comment-classify・500） | `ANTHROPIC_API_KEY` 未設定 | §1 の手順で投入（pulse-summary と共用） |
| `{"error":"no_channel_configured"}`（pulse-alert-digest・400・preview除く） | `SLACK_BOT_TOKEN` 未設定 | §2-1 の手順で投入（pulse-notify と共用） |
| `{"ok":true,"sent":0,"skipped":"no_recipients"}` | `pulse_settings.alert_digest_recipients` が空 | #/pulse/admin の「アラート通知」で通知先メールを追加（§10-8） |
| `{"ok":true,"sent":0,"skipped":"disabled"}` | `alert_digest_enabled` / `alert_immediate_enabled` が false | 同画面でON（`pulse_update_alert_notify_settings`） |
| `{"ok":true,"sent":0,"skipped":"no_alerts"}` | 未通知アラートが0件 | 正常（対応不要） |
| `{"error":"missing authorization"}` / `{"error":"permission denied"}` | JWTなし・`pulse_can_manage_alert()` が false／cronのつもりがヘッダ名 or secret値が不一致 | ヘッダ名 `x-cron-secret` と `PULSE_CRON_SECRET` の値を突き合わせる |
| `{"error":"invalid_mode"}` / `{"error":"invalid_input"}` | body の `mode` が3値以外、または `immediate` で `alert_ids` 未指定・空配列 | 呼び出し側の body を修正（§3-2 の形に合わせる） |
| daily の応答に `"classify":{"ok":false,...}` が乗る | `pulse-comment-classify` へのHTTP呼び出し失敗（例: 未デプロイ・関数名タイポ） | daily 自体は続行して通知は届く。原因切り分けは3-3の4番目のコマンドを直接叩く |
| pg_cron は動いているはずなのに何も届かない | Vault `pulse_cron_secret` 未投入、または migration 0051 未適用 | §2-4 と同じ要領で `select vault.create_secret('<値>', 'pulse_cron_secret');`（0050で既に投入済みなら不要）→ `cron.job_run_details` / functions logs で到達を確認 |

サーバ側ログ（Claude応答のパース失敗・RPC失敗など、レスポンスの `errors` 件数以上の詳細）は
`supabase functions logs pulse-alert-digest --project-ref kgofrmfsfnxbzqkfrkqo` /
`supabase functions logs pulse-comment-classify --project-ref kgofrmfsfnxbzqkfrkqo` で確認する。

### v3 P2 残タスク

- [ ] migration `0051_pulse_v3_p2.sql` 適用（backend 担当分。`pulse_alert_rules` 拡張・
      `pulse_alerts` 拡張・`pulse_comment_classifications` 新設・`pulse_alert_digest_batch` 等の
      RPC・`pulse_cron_fire_alert_digest` の cron 登録・PULSE_V3_DESIGN.md §10-1〜§10-7）
- [ ] Edge Function 2本を §0 のコマンドで（再）デプロイ：`pulse-alert-digest` / `pulse-comment-classify`
      （**どちらも verify_jwt=false・config.toml で固定**）
- [ ] `pulse_settings.alert_digest_recipients` に人事管理者のメールを設定（#/pulse/admin・
      `pulse_update_alert_notify_settings`）。空のままだと daily/immediate は `skipped:"no_recipients"`
- [ ] §3-3 の `mode:"preview"` で本文を確認 → `mode:"daily"` を手動実行 → 実際に Slack DM が届くか確認
- [ ] SOS／体調不安のコメントを含むテスト回答を送信 → `pulse__request_immediate` 経由で
      `mode:"immediate"` が自動起動し即時DMが届くことを確認
- [ ] フロント（`src/`）が `#/pulse/alerts` 全面改修・`#/pulse/admin` のアラートルール／通知設定
      セクションに対応済みであること（frontend 担当分・PULSE_V3_DESIGN.md §10-8）
