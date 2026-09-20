# TalentHub パルスサーベイ v3（Geppo置換）— 実装設計書（P0/P1・実装エージェント向けSSoT）

リポジトリ: `~/projects/active/meta/org-chart-prototype`（worktree `../org-chart-prototype.pulse-v3`・branch `feat/pulse-v3`・base 24449df）
スタック: Vite + React + TypeScript + Zustand + Supabase（純クライアントSPA・書込は SECURITY DEFINER RPC／Edge Function 専有）
検証: `npx tsc -b` ／ `npx vite build`。Edge Function はローカル `deno run` で HTTP を叩いて確認。
上位の決定: memory `project_talenthub_pulse_v3`（設計決定9件・2026-09-20 裕鵬さん裁定）。**決定に反する設計変更は再グリルが要る＝この文書の範囲で勝手に変えない。**
既存実装の理解: `docs/PULSE_V2_DESIGN.md`（v2 の完成形）と `~/_scratch/talenthub-pulse-v3/01_existing_pulse_analysis.md`（全章分析）。

---

## 0. 決定の要約（設計の前提・変えない）

| # | 論点 | 決定 |
|---|---|---|
| 1 | 上長への開示 | 自組織の集計＋メンバーの天気（仕事/健康/評価）を実名。「対人」の個人値とコメント本文は人事のみ。**回答画面に閲覧者（人事＋上長名）を明示** |
| 2 | 回答方式 | **本人専用トークンURL（Slack DM→1タップ・ログイン不要）**。履歴・集計はログイン必須 |
| 3 | 対象者 | 雇用形態で規定＋個別除外（内訳は P0 で実データ確定） |
| 4 | 設問 | 現行 seed「天気4問（仕事/対人/健康/評価）＋eNPS＋自由記述」を毎月。合計20点 |
| 5 | アラート | 人事管理者へ日次ダイジェスト。上長には通知しない（P2） |
| 6 | 配信承認 | 初回だけ裕鵬さん承認・以後は定期ルールで自動 |
| 7 | 移行 | Geppo CSV 取込・**11/15 から TalentHub 配信**・1月 Geppo 解約（P3） |
| 8 | 上長任命 | 人事管理者が設定画面で任命（P5） |
| 9 | 配信日 | 毎月15日 9:00・**リマインド2営業日おき×最大4回**・月末締切・翌1日ダイジェスト |

本書のスコープ＝ **P0（活性化準備）＋ P1（回答摩擦ゼロ）** のみ。P2 以降は §9 の要約だけ持つ。

---

## 1. P0 実測（2026-09-20・本番 DB `kgofrmfsfnxbzqkfrkqo`）

- 設問セット「月次パルスサーベイ v1」（id `6e8947b5-0d3b-4756-a24f-5b5e9aec9481`）は **既に active（2026-07-31 有効化済・設問は凍結）**。文言を変えるなら「複製→新版編集→有効化」の運用。
  1. 仕事「仕事の充実度・手応えはどうですか？」weather5
  2. 対人「職場の人間関係・コミュニケーションはどうですか？」weather5
  3. 健康「心と体のコンディションはどうですか？」weather5
  4. 評価「自分への評価・処遇に納得できていますか？」weather5
  5. eNPS「SHO-SANで働くことを、親しい友人や知人にどの程度すすめたいですか？」nps
  6. 自由記述「共有したいこと・気になっていることがあれば自由にご記入ください」free_text
- サイクル: `2026-08`（closed・回答0件・7/31 のテスト）。受付中サイクルなし。responses/answers/alerts/notifications/access はすべて 0 件。
- migration 履歴: 0048 まで remote に記録済（クリーン）。**次の採番＝0049**。
- 拡張: `pg_cron` / `pg_net` は **未有効**。`supabase_vault` は有効・secret 0 件。`cron.job` 未登録。
- Edge secrets: 6種すべて未投入（休眠状態のまま）。
- employees 在籍 181 名の雇用形態: 正社員 57／限定正社員 12／契約社員 2（うち1名 9月入社）／役員 1／アルバイト・パート 109（108名が gmail）。**Geppo 66名 ≒ 正社員＋限定正社員（69）− 執行役員3 と推定**（Geppo 名簿 CSV で確定）。

---

## 2. P1 の全体像（データの流れ）

```
[pg_cron 09:00 JST 日次] ──http_post(x-cron-secret)──▶ pulse-notify(mode=reminder)
[管理画面 一斉送信(初回承認)] ──JWT(pulse_can_manage_alert)──▶ pulse-notify(mode=broadcast)
        └─ 対象者 = pulse_is_target(emp)（雇用形態＋個別除外）
        └─ 本人専用URL = {APP_URL}/#/survey?t=<token>   token = HMAC(cycle_id, employee_number, exp)
        └─ 文面 = pulse_settings のテンプレ（{name}{month}{url}{due}…）
        └─ 記録 = pulse_notifications（reminder_no 付き）

[社員 Slack DM 1タップ] ─▶ #/survey?t=… ─▶ Edge pulse-answer（verify_jwt=false・トークン検証）
        ├─ action=get    → rpc pulse_survey_bundle_for(emp, cycle)   (service_role 専有)
        └─ action=submit → rpc pulse_submit_response_for(emp, cycle, answers, comment) → bundle 再取得
[社員 ログイン済 #/survey] ─▶ rpc pulse_my_survey() / pulse_submit_response()（既存経路・同じ bundle 形）
[社員 ログイン済 #/survey/history] ─▶ rpc pulse_my_history()（comment/sum_score を追加）
```

**トークンで到達できるのは回答フォーム（bundle）と送信だけ**。履歴・集計・他人のデータは Edge から一切返さない（決定2）。

---

## 3. バックエンド（migration `0049_pulse_v3_p1.sql`・`0050_pulse_reminder_cron.sql`）

流儀: 0021〜0045 と同じ（SECURITY DEFINER・`set search_path = public`・`revoke all … from public, anon`・必要な役割にだけ grant・**冪等**＝`create or replace` / `drop policy if exists` / `on conflict do nothing`）。0049 は 1トランザクション（`begin; … commit;`）。

### 3-1. `pulse_settings`（シングルトン・運用設定）

```sql
create table if not exists public.pulse_settings (
  id smallint primary key default 1 check (id = 1),
  viewer_notice text not null default '',            -- 回答画面冒頭に出す「閲覧者の明示」文
  manager_disclosure_enabled boolean not null default false, -- ON なら上長名を自動で足す（決定1）
  target_employment_types text[] not null default '{正社員,限定正社員}', -- 決定3（P0推定・裕鵬さん確定待ち）
  notify_broadcast_template text not null default '…',  -- §3-6
  notify_reminder_template  text not null default '…',
  notify_email_subject_template text not null default '…',
  reminder_interval_business_days smallint not null default 2 check (between 1 and 10),
  reminder_max_count smallint not null default 4 check (between 0 and 10),
  survey_minutes smallint not null default 1,          -- 「所要1分」表記
  updated_at timestamptz not null default now(),
  updated_by_email text
);
insert into public.pulse_settings (id) values (1) on conflict do nothing;
```

- `viewer_notice` 既定値（裕鵬さんが設定画面で書き換える前提の初期文）:
  `あなたの回答は、人事担当（高谷・丹野）が閲覧します。回答内容は本人の許可なく他の人に共有されることはありません。`
- RLS: SELECT＝`pulse_is_admin() or pulse_scope() <> 'self'`／書込＝`pulse_is_admin()`。回答者へは RPC/Edge 経由で `viewer_notice` だけ渡す（テーブル直読はさせない）。
- `updated_at`/`updated_by_email` は既存 0021 の流儀と同じトリガで自動更新（updated_by_email = auth.email()）。

### 3-2. `pulse_target_exclusions`（個別除外・決定3）

```sql
create table if not exists public.pulse_target_exclusions (
  employee_number text primary key references public.employees(employee_number) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  created_by_email text
);
```
RLS: SELECT/書込とも `pulse_is_admin()`。UI は P3（今回は SQL 直接投入で運用）。

### 3-3. 対象者判定・営業日ヘルパー

- `pulse_is_target(p_emp text) returns boolean`（SECURITY DEFINER・stable）: 在籍（left_at is null）かつ `employment_type = any(settings.target_employment_types)` かつ除外テーブルに無い。
- `pulse_target_count() returns integer`: `pulse_is_target` を満たす人数。**`pulse_compute_aggregates`（0045:121）と `pulse_admin_cycle_stats`（0045:499）の分母 `count(*) where left_at is null` をこれに置換**（関数本体は 0045 版を丸ごとコピーして該当行だけ差し替え）。
- `pulse_holidays (holiday_date date primary key, name text, kind text default 'national')`: 祝日 seed（2026-10〜2027-12 の国民の祝日・振替休日）。RLS: SELECT authenticated／書込 admin。※内閣府公表値との照合は裕鵬さん確認事項として README に残す。
- `pulse_is_business_day(d date) returns boolean`: 月〜金 かつ pulse_holidays に無い。
- `pulse_business_days_after(p_from date, p_to date) returns integer`: 区間 `(p_from, p_to]` の営業日数（p_from 当日は数えない）。

### 3-4. 回答 bundle RPC（トークン経路とログイン経路で同じ形）

内部関数 `public.pulse__survey_bundle(p_emp text, p_cycle_id uuid) returns jsonb`（SECURITY DEFINER・**public/anon/authenticated すべて revoke・service_role にも grant しない＝内部専用**）。返す JSON:

```jsonc
{
  "employee_number": "10018",
  "display_name": "丹野 裕鵬",          // employees.display_name ?? full_name
  "is_target": true,                    // pulse_is_target
  "cycle": { "id": "…", "period": "2026-11", "send_date": "2026-11-15", "due_date": "2026-11-30", "status": "sent" },
  "questions": [ { "id": "…", "sort_order": 1, "label": "…", "category": "仕事", "type": "weather5" } ],
  "response": { "id": "…", "answered_at": "…", "comment": "…", "updated_at": "…" } | null,
  "answers": [ { "question_id": "…", "score": 4, "value_text": null } ],
  "viewers": {
    "notice": "<pulse_settings.viewer_notice>",
    "manager_disclosure": false,
    "manager_names": []                 // §3-5
  },
  "previous": { "period": "2026-10", "by_category": { "仕事": 4, "対人": 3, "健康": 5, "評価": 3 }, "nps": 8, "answered_at": "…" } | null
}
```
- `previous` = 本人の回答がある直近の過去サイクル（period < 当サイクル・status in ('sent','closed')）。`by_category` は category ごとの平均（weather5/scale のみ）。
- 社員が見つからない（在籍でない）なら `null`。
- **公開RPC 2本**:
  - `pulse_my_survey() returns jsonb`（authenticated）: `pulse_current_employee_number()` → 受付中（status='sent'）の最新サイクルを取って bundle。受付中が無ければ `{"cycle": null}`。本人特定不可なら `null`。
  - `pulse_survey_bundle_for(p_emp text, p_cycle_id uuid) returns jsonb`（**service_role 専用**・authenticated からは revoke）: Edge `pulse-answer` 用。
- 既存 `pulse_my_response(uuid)` は互換のため残す（呼び出し元はフロント改修で消える）。

### 3-5. 閲覧者の明示（決定1）— 上長名の解決

`manager_names` は **既存の `pulse_access`（scope='own_unit'）を上長の実体として使う**（新テーブルは作らない。P5 の任命UIはこのテーブルへ書く）:

```
settings.manager_disclosure_enabled = true のとき、
  pulse_access pa where pa.scope = 'own_unit'
    and employees(e).department = any(pa.own_unit_departments)   -- pulse_can_view_employee と同じ一致条件
    and pa.email <> 本人の email
  → その pa.email に対応する employees の display_name ?? full_name を配列で
```
OFF なら `[]`。将来「階層で配下まで」に変える時は `pulse_can_view_employee` と**同時に**変える（見えている人と告知する人を一致させる）。

### 3-6. 回答保存 RPC の共通化

- 内部 `pulse__submit_response(p_emp text, p_cycle_id uuid, p_answers jsonb, p_comment text) returns uuid`（内部専用）: 0030 版 `pulse_submit_response` の本体をここへ移す。追加の検証: `pulse_is_target(p_emp)` でなければ例外 `not_target`／`p_comment` と各 `value_text` は 2000 文字上限／status <> 'sent' は例外（既存）。
- 公開 `pulse_submit_response(p_cycle_id, p_answers, p_comment)`（authenticated・既存シグネチャ維持）: `pulse_current_employee_number()` → 内部関数へ委譲。
- 新 `pulse_submit_response_for(p_emp text, p_cycle_id uuid, p_answers jsonb, p_comment text) returns uuid`（**service_role 専用**）: Edge 用。

### 3-7. `pulse_my_history()` の拡張（振り返り用）

各要素に `cycle_id`, `sum_score`（weather5/scale の合計＝20点満点）, `comment`（本人の自由記述）を追加。既存キーは維持（フロント互換）。

### 3-8. 通知テーブル

`pulse_notifications` に `reminder_no smallint`（broadcast は null／reminder は 1..N）と index `(cycle_id, employee_number, kind)` を追加。

### 3-9. 配信テンプレ既定値（`pulse_settings`）

プレースホルダ: `{name}`（表示名）`{month}`（「11月」）`{period}`（2026-11）`{url}`（本人専用URL）`{due}`（11/30）`{minutes}`（所要分）。

- broadcast 既定: `{name}さん、{month}分のパルスサーベイの回答をお願いします（所要{minutes}分）\n{url}\n締切：{due}まで。このURLはあなた専用です（転送しないでください）。`
- reminder 既定: `{name}さん、{month}分のパルスサーベイがまだ回答されていません（所要{minutes}分）\n{url}\n締切：{due}まで。`
- email subject 既定: `【TalentHub】{month}分パルスサーベイのご回答のお願い`

### 3-10. RLS の締め（P1-5）

`pulse_question_sets` / `pulse_questions` / `pulse_cycles` の SELECT ポリシー `… read (authenticated)` (`using (true)`) を **drop** し、`using (pulse_is_admin() or pulse_scope() <> 'self')` に差し替える（0045 の `pulse_monthly_aggregates` と同じ述語）。回答者はテーブルを直読しない（§3-4 RPC 経由）。書込ポリシーは不変。フロントで直読しているのは `src/store/usePulseStore.ts`（pulse_cycles:99・pulse_questions:122）だけ＝§5 で RPC へ置換する。

### 3-11. `0050_pulse_reminder_cron.sql`（リマインド自動化・secret 値は入れない）

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
-- 今日リマインド対象のサイクル（営業日ベース・決定9）
create or replace function public.pulse_cron_due_cycles(p_today date default current_date)
returns table (cycle_id uuid, period text, business_days integer) … -- status='sent' and send_date is not null
   -- and due_date >= p_today and pulse_is_business_day(p_today)
   -- and bd = pulse_business_days_after(send_date, p_today)
   -- and bd > 0 and bd % settings.reminder_interval_business_days = 0
   -- and bd / interval <= settings.reminder_max_count
-- pg_cron から呼ぶ本体。secret は Vault から取る（名前 'pulse_cron_secret'）。無ければ何もしない。
create or replace function public.pulse_cron_fire_reminders() returns integer … security definer
   -- for each due cycle: perform net.http_post(url := '<SUPABASE_URL>/functions/v1/pulse-notify',
   --   headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', v_secret),
   --   body := jsonb_build_object('cycle_id', c.id::text, 'mode','reminder'))
   -- returns 発火数
select cron.schedule('pulse-reminders', '0 0 * * *', $$select public.pulse_cron_fire_reminders()$$)
  where not exists (select 1 from cron.job where jobname = 'pulse-reminders');
```
- Functions URL は `https://kgofrmfsfnxbzqkfrkqo.supabase.co/functions/v1/pulse-notify` を関数内定数に持つ（secret ではない）。
- Vault 投入（裕鵬さん・1回・SQL Editor）: `select vault.create_secret('<PULSE_CRON_SECRET と同じ値>', 'pulse_cron_secret');` → runbook §④ をこれに書き換える。
- `pulse_cron_due_cycles()` は dry-run 確認用（admin から `select * from pulse_cron_due_cycles()`）。

---

## 4. Edge Functions（`supabase/functions/`）

共通: Deno・`https://esm.sh/@supabase/supabase-js@2`・CORS/json ヘルパは既存 pulse-notify と同型。**`_shared/pulseToken.ts` を新設**して notify/answer で共有。

### 4-1. トークン（`_shared/pulseToken.ts`）

- 鍵材料: `PULSE_TOKEN_SECRET`（任意 secret）があればそれ、無ければ `SUPABASE_SERVICE_ROLE_KEY`。**どちらも直接は使わず** `K = HMAC-SHA256(key=材料, msg="talenthub-pulse-answer-v1")` で派生鍵を作る（Web Crypto `crypto.subtle`）。
- payload（UTF-8）: `v1|<cycle_id>|<employee_number>|<exp_unix>`。
- token: `base64url(payload) + "." + base64url(HMAC-SHA256(K, payload))`。
- `signPulseToken({cycleId, employeeNumber, exp})` / `verifyPulseToken(token) → {cycleId, employeeNumber, exp} | null`（`crypto.subtle.verify` で定数時間比較・形式不正/期限切れは null）。
- `exp` = サイクル `due_date` の **23:59:59 JST**（due_date null なら send_date+31日、それも無ければ now+31日）。
- 単体テスト `_shared/pulseToken_test.ts`（`deno test`）: 署名→検証／改竄→null／期限切れ→null／別鍵→null。

### 4-2. `pulse-answer`（新設・**`--no-verify-jwt` でデプロイ**）

- `POST { t: string, action: "get" | "submit", answers?: [{question_id, score, value_text}], comment?: string }`
- 手順: token 検証（失敗→400 `invalid_token`／期限切れ→410 `expired`）→ service_role で `pulse_cycles` を取り `status='sent'` を確認（違えば 409 `closed`）→
  - get: `rpc pulse_survey_bundle_for` → `is_target=false` なら 403 `not_target`／null なら 404 `not_found`／200 `{ ok, bundle }`
  - submit: `rpc pulse_submit_response_for` → 例外は 400 に文言ごと（`not_target` は 403）→ 成功後 bundle を再取得して 200 `{ ok, bundle }`
- **返すのは bundle だけ**（email・他人・履歴・集計は返さない）。token をログ出力しない。answers は最大 50 件・comment 2000 字でクライアント検証も入れる（サーバ側は RPC が最終防衛）。
- 認可ヘッダは見ない（トークンが認可）。`OPTIONS` は CORS のみ。

### 4-3. `pulse-notify`（改修）

- 対象者: `employees` 在籍＋email あり → **`rpc pulse_is_target` で絞る**（service_role で `select employee_number from employees where left_at is null` → 関数で判定。まとめて判定できる `pulse_target_employee_numbers()` を 0049 に足してよい）。
- 文面: `pulse_settings` を service_role で読み、テンプレ＋プレースホルダ展開（§3-9）。`{url}` は本人専用トークン URL `${APP_URL}/#/survey?t=${token}`。
- モード:
  - `broadcast`（既存・JWT `pulse_can_manage_alert`）: 対象者全員。**同一 cycle・同一 channel で `status='sent'` の broadcast 記録がある人はそのチャネルをスキップ**（再実行が安全＝冪等）。
  - `reminder`（cron の `x-cron-secret` か JWT）: 未回答の対象者のみ。`pulse_notifications` の reminder 件数（slack/email いずれか）を数え、`reminder_max_count` 以上ならスキップ、**JST 同日に送信済ならスキップ**、それ以外は `reminder_no = 既存件数+1` で送信・記録。
  - `preview`（**新設**・JWT のみ）: 送信しない。`{ ok, mode:"preview", targets:<人数>, my_url:<呼び出し本人の専用URL|null>, text_broadcast, text_reminder, email_subject }` を返す。本人（auth.email ↔ employees.email）が対象者なら実 URL、そうでなければ `my_url:null` と「○○さん」サンプル文。**他人の URL は絶対に返さない**（管理者でも）。
- `no_channel_configured` は broadcast/reminder のみ（preview は secrets 無しでも動く＝secrets 未投入の間の検証手段）。
- 記録: `pulse_notifications` に `reminder_no` を入れる。レスポンスの `counts` は既存キー維持＋`skipped` を追加。

### 4-4. `pulse-summary`（P0-1 修正・n<5 マスク）

- 当サイクルの回答者数（`pulse_responses` 件数）が **5 未満なら `comments` を空配列にし**、`context.comments_note = "回答者5名未満のためコメントは要約に含めていません"` を付ける。`meta.comments_masked: true` を保存。
- 既存の by_department の masked 除外は維持。プロンプトに「コメントが無い場合は主要テーマを『コメント非表示（少人数）』と書く」を1行追加。

### 4-5. デプロイ（コード変更時・許可済み）

```bash
supabase functions deploy pulse-answer  --no-verify-jwt --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-notify  --no-verify-jwt --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-summary --project-ref kgofrmfsfnxbzqkfrkqo
```
`PULSE_PROVISIONING.md` §0 に `pulse-answer`／`pulse-notify` の `--no-verify-jwt` を明記する（verify_jwt=true で上書きデプロイするとトークン回答・cron リマインドが全滅する。独立レビュー 2026-09-20 指摘）。0050 は保険として Vault `pulse_anon_key` があれば Authorization も付ける。

---

## 5. フロントエンド

### 5-1. ルーティング（`src/store/useUiStore.ts`・`src/App.tsx`）

- `#/survey` → `{ name: "survey" }`（既存・ログイン経路）
- `#/survey?t=<token>` → `{ name: "survey", token }`（`#/survey?` 以降を `URLSearchParams` で読む。`t` 空なら token なし扱い）
- `#/survey/history` → `{ name: "survey_history" }`
- App.tsx: **`route.name === "survey" && route.token` は認証ゲートの前で描画**（`annShareToken` と同じ位置・セッション有無に関わらず動く）。token 無しの `survey` と `survey_history` は従来どおりゲート後・chrome 無し。

### 5-2. `usePulseStore`（回答ストアの二経路化）

- `loadSurvey({ token?: string })`:
  - token あり → `supabase.functions.invoke("pulse-answer", { body: { t: token, action: "get" } })`。**セッションが無くても呼べる**（anon key のみ）。エラー本文の `error` を日本語に変換（invalid_token「このリンクは無効です」／expired「このリンクは期限切れです（締切を過ぎています）」／closed「この月の受付は終了しました」／not_target「回答対象として登録されていません」）。
  - token なし → `rpc("pulse_my_survey")`。`null` → not_target／`{cycle:null}` → 受付中なし。
  - どちらも同じ state へ: `cycle / questions / eligibility / alreadyAnswered / answers / comment / displayName / viewers / previous`。
- `submit()`: token → `pulse-answer` action=submit（成功レスポンスの bundle で `previous`・`answers` を更新）／セッション → `rpc pulse_submit_response`（既存）→ その後 `pulse_my_survey` を再取得して `previous` を更新。
- `pulse_cycles` / `pulse_questions` の直読を撤去（§3-10 の RLS で読めなくなる）。

### 5-3. `SurveyPage`（`#/survey`・token/セッション共通）

- 冒頭（対象月・締切の直下）に **「閲覧者」ボックス**（lucide `Eye`）: `viewers.notice` をそのまま表示。`manager_disclosure && manager_names.length>0` なら「上長（○○）も閲覧します」を 1 行追加。token モードでは「このURLはあなた専用です」を小さく併記。
- 送信後のサンクス画面: 既存のチェック＋「回答を見直す」に加えて **「前回との比較」**（カテゴリ×[前回の天気 → 今回の天気]＋矢印 ↑/→/↓・eNPS も 1 行）。`previous` が null なら「初回の回答です。来月から前回との比較が出ます」。締切まで同じ URL から修正できる旨は既存文言を維持。
- 「振り返りを見る」→ `#/survey/history`（ログイン必須の旨を添える。token モードでセッションが無ければ SignIn へ流れる）。**token モードでは「マイパルス」スパークライン（履歴）を出さない**（決定2＝履歴はログイン必須）。セッションモードは既存どおり。
- token モードのフッター: 「ホームへ」はセッションがある時だけ。not_target/invalid/expired/closed の各状態は行き止まりにしない（案内文＋「ログインして開く」）。
- モバイル前提（既存 survey.css・44px タップ領域・720px ブレークポイント）を維持。

### 5-4. `SurveyHistoryPage`（`#/survey/history`・新設・chrome 無し・ログイン必須）

- データ: `rpc pulse_my_history`（§3-7 拡張版）。
- 上段カード 3 枚: 回答回数／コメント回数／直近の合計（/20 点）。
- **6か月グリッド**: 行＝仕事／対人／健康／評価／eNPS、列＝直近 6 periods（無い月は「—」）、セル＝天気絵文字（`WEATHER_SCALE`）・eNPS は数値。
- 全期間リスト: period・4天気・合計/20・eNPS・コメント（折りたたみ）。降順。
- フッター: 「回答画面へ」（#/survey）「ホームへ」（#/）。
- CSS は `src/components/pulse/survey.css` の `.pulse__` 語彙を流用し、必要分だけ `history.css` を追加。

### 5-5. 管理画面（`PulseAdminPage` / `usePulseAdminStore`・小改修）

- `notifyCycle(id, mode)` に `"preview"` を追加。
- 受付中サイクル行に **「文面と自分用URLを確認」** ボタン → preview 結果をモーダル or 行内に表示（対象人数・broadcast 文・reminder 文・自分用 URL＋コピー）。
- 既存の `no_channel_configured` 時「回答URLをコピー」は **自分用 URL（my_url）をコピー**に変更（`my_url` が null なら従来の `#/survey` にフォールバック）。
- 確認ダイアログ文言「全在籍者へ実行」→「対象者（雇用形態ルール適用・N名）へ実行」（N は preview の targets を表示できれば表示）。

### 5-6. 受入条件

- `npx tsc -b` / `npx vite build` green。
- `#/survey?t=<有効token>` がログイン無しで開き、回答→送信→前回比較が出る。同 URL 再訪でプレフィルされ修正できる。
- 改竄 token／期限切れ／closed サイクルで日本語の案内が出て、他人のデータは一切出ない。
- `#/survey`（ログイン）が従来どおり動く（pulse_my_survey 経由）。`#/survey/history` に 6か月グリッドが出る。
- 管理画面「文面と自分用URLを確認」で本人 URL が取れる（secrets 未投入でも動く）。
- 既存の管理ページ（#/pulse 配下 5 画面）が非回帰（RLS 変更で admin が影響を受けない）。

---

## 6. 独立レビュー観点（自己PASS禁止・別エージェント）

1. トークン署名: 鍵派生・定数時間比較・exp・payload の区切り文字衝突（employee_number に `|` が入る可能性→ base64url で個別エンコードしているか）・`--no-verify-jwt` 前提の入力検証。
2. RLS: 3テーブルの SELECT 締めで admin/pulse_access 保有者が壊れないか・回答者が直読に依存していないか・新テーブル（settings/exclusions/holidays）の default-deny。
3. n<5 マスク: pulse-summary のコメント抑止・by_department masked 除外の維持。
4. なりすまし耐性: preview が他人の URL を返さない・service_role 専用 RPC が authenticated から呼べない（`revoke`）・`pulse_submit_response_for` が `pulse_is_target` と status='sent' を守る・Edge が email 等を返さない。
5. 冪等・再実行: broadcast の再実行でチャネル別スキップ・reminder の同日重複防止と上限・cron の due 判定（営業日）。

---

## 7. 運用手順の更新（docs）

- `docs/PULSE_ACTIVATION_RUNBOOK.md`: ①secrets（`PULSE_TOKEN_SECRET` は任意・**初回配信前に決める**と明記）／④ pg_cron は `0050` が登録するので **Vault へ `pulse_cron_secret` を入れる SQL 1行**に置換／⑤ 5-1 は「既に有効化済（変更は複製→新版）」に改訂／5-3 に「文面と自分用URLを確認」を追加／対象者ルール（settings.target_employment_types・exclusions）の SQL 例を追加。
- `supabase/functions/PULSE_PROVISIONING.md`: §0 に `pulse-answer --no-verify-jwt`、`_shared/pulseToken.ts` の鍵派生、preview モード、n<5 マスクを追記。

---

## 8. 作業分担と停止線

| エージェント | 触るファイル | 触らない |
|---|---|---|
| backend | `supabase/migrations/0049_*.sql` `0050_*.sql`・runbook §④/対象者 SQL 例 | `src/`・`supabase/functions/` |
| edge | `supabase/functions/_shared/`・`pulse-answer/`・`pulse-notify/`・`pulse-summary/`・`PULSE_PROVISIONING.md` | `src/`・migrations |
| frontend | `src/store/useUiStore.ts`・`src/App.tsx`・`src/store/usePulseStore.ts`・`src/components/pulse/SurveyPage.tsx`・`SurveyHistoryPage.tsx`・`survey.css`/`history.css`・`PulseAdminPage.tsx`・`usePulseAdminStore.ts`・`src/lib/pulse.ts` | migrations・functions |

- **git 操作はしない**（commit は CEO がパス明示で行う）。`db push`／`functions deploy`／`vercel` も CEO が行う。
- 契約（bundle の JSON 形・エラーコード・RPC 名）は本書が正。変えたくなったら本書を直してから実装する。

---

## 9. P2 以降（別チャット・要約のみ）

- **P2 アラート**: Geppo 互換3基準（荒天／2段階下落で雨以下／雨以下2項目）＋プリセット（主務組織変更・3か月同回答・全曇り・3か月未回答）・回答時自動判定・5状態（未対応/対応中/対応済/対応不要/保留(組織課題)）・一括更新・人事日次ダイジェスト（SOS/体調不安は即時）・振り返り・Claude コメント分類。
- **P3 自動化・移行**: 月次サイクル自動生成（15日 9:00）・月末締切自動 close・翌1日ダイジェスト・Geppo CSV 取込（source=geppo_import・コメント含む）・対象者ルール UI。
- **P4 レポート**: 従業員別（Geppo03型）・組織別（組織図階層＋偏差値）・分析クロス・ダッシュボード刷新。
- **P5 権限**: 上長任命 UI（pulse_access scope=own_unit へ書く・組織図の版変更で見直し通知）・ナビ判定統一・`#/pulse/team`・RLS 締め直し。**制約（P1 レビュー由来）**: `pulse_access` に `scope='self' かつ can_manage_alert=true` の行を作らない（Edge の認可は通るが §3-10 の SELECT 述語で cycles/questions が読めず管理画面が壊れる）。任命 UI ではこの組み合わせを禁止する。
- **P6**: Slack 内回答モーダル・経営閲覧ロール・PDF。
- 分析原本: `~/_scratch/talenthub-pulse-v3/`（01 既存分析／02 Geppo 画面棚卸し／03 公開仕様／構想 HTML）。構想ページ: https://claude.ai/artifact/1oS9ufNjnDRjhju4SgzHrG
