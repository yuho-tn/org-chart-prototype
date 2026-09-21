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

- 鍵材料: 専用 secret `PULSE_TOKEN_SECRET`（**必須**・7種目の secret）。**直接は使わず** `K = HMAC-SHA256(key=材料, msg="talenthub-pulse-answer-v1")` で派生鍵を作る（Web Crypto `crypto.subtle`）。未設定なら両関数が 500 `token_secret_not_configured` を明示的に返す。※当初の `SUPABASE_SERVICE_ROLE_KEY` フォールバックは撤回（2026-09-20 実測: Runtime 注入値が legacy JWT → sb_secret に切り替わっており CLI から確認不能＝配布済みURLが月中に失効し得る）。
- payload（UTF-8）: `v1|<cycle_id>|<employee_number>|<exp_unix>`。
- token: `base64url(payload) + "." + base64url(HMAC-SHA256(K, payload))`。
- `signPulseToken({cycleId, employeeNumber, exp})` / `verifyPulseToken(token) → {cycleId, employeeNumber, exp} | null`（`crypto.subtle.verify` で定数時間比較・形式不正/期限切れは null）。
- `exp` = サイクル `due_date` の **23:59:59 JST**（due_date null なら send_date+31日、それも無ければ now+31日）。
- 単体テスト `_shared/pulseToken_test.ts`（`deno test`）: 署名→検証／改竄→null／期限切れ→null／別鍵→null。

### 4-2. `pulse-answer`（新設・**verify_jwt=false（config.toml で固定）でデプロイ**）

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
supabase functions deploy pulse-answer  --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-notify  --project-ref kgofrmfsfnxbzqkfrkqo
supabase functions deploy pulse-summary --project-ref kgofrmfsfnxbzqkfrkqo
```
verify_jwt は **`supabase/config.toml` で関数ごとに固定**（pulse-answer / pulse-notify / smarthr-sync / employees-export = false、pulse-summary = true）。デプロイ時のフラグ運用は廃止（付け忘れ1回でトークン回答・cron リマインドが全滅する構造だった＝独立レビュー 2026-09-20 指摘）。デプロイ後は `supabase functions list` で verify_jwt を目視する。0050 は保険として Vault `pulse_anon_key` があれば Authorization も付ける。

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

1. トークン署名: 鍵派生・定数時間比較・exp・payload の区切り文字衝突（employee_number に `|` が入る可能性→ base64url で個別エンコードしているか）・verify_jwt=false 前提の入力検証。
2. RLS: 3テーブルの SELECT 締めで admin/pulse_access 保有者が壊れないか・回答者が直読に依存していないか・新テーブル（settings/exclusions/holidays）の default-deny。
3. n<5 マスク: pulse-summary のコメント抑止・by_department masked 除外の維持。
4. なりすまし耐性: preview が他人の URL を返さない・service_role 専用 RPC が authenticated から呼べない（`revoke`）・`pulse_submit_response_for` が `pulse_is_target` と status='sent' を守る・Edge が email 等を返さない。
5. 冪等・再実行: broadcast の再実行でチャネル別スキップ・reminder の同日重複防止と上限・cron の due 判定（営業日）。

---

## 7. 運用手順の更新（docs）

- `docs/PULSE_ACTIVATION_RUNBOOK.md`: ①secrets（`PULSE_TOKEN_SECRET` を 7種目として追加・**初回配信前に決めて固定**と明記）／④ pg_cron は `0050` が登録するので **Vault へ `pulse_cron_secret` を入れる SQL 1行**に置換／⑤ 5-1 は「既に有効化済（変更は複製→新版）」に改訂／5-3 に「文面と自分用URLを確認」を追加／対象者ルール（settings.target_employment_types・exclusions）の SQL 例を追加。
- `supabase/functions/PULSE_PROVISIONING.md`: §0 に config.toml による verify_jwt 固定、`_shared/pulseToken.ts` の鍵派生、preview モード、n<5 マスクを追記。

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

---

## 10. P2 アラート — 実装契約（branch `feat/pulse-v3-p2`・migration `0051_pulse_v3_p2.sql`・2026-09-21）

決定5（人事管理者へ日次ダイジェスト・SOS/体調不安は即時・**上長には通知しない**・対応も人事）と決定1（上長に見せるアラートは仕事/健康/評価由来のみ）に従う。§8 と同じ分担（backend / edge / frontend）で、契約は本節が正。

### 10-0. 用語・前提

- **天気4カテゴリ**＝`pulse_questions.category` の `仕事`／`対人`／`健康`／`評価`（weather5・1..5、1=荒天・2=雨・3=くもり・4=晴れ・5=快晴）。
- **合計スコア**＝天気4問の合計（20点満点）。**総合（overall）**＝天気4問の平均（既存の `avg_overall` と同義）。
- **前回**＝本人が回答した直近の過去サイクル（period 昇順で直前・status in ('sent','closed')）。「3か月」＝本人回答があるサイクル直近3件が **period で暦月連続**していること（飛んだ月があれば不成立＝既存 `isConsecutiveDecline` と同じ）。
- **人事管理者（通知先）**＝`pulse_settings.alert_digest_recipients text[]`（メール・既定 `{}`）。空なら通知はスキップし、管理画面に「通知先未設定」を出す。閲覧権限は従来どおり `pulse_can_manage_alert()`（admin または pulse_access.can_manage_alert）。
- 上長（P5 で `pulse_access.scope='own_unit'` になる人）は **通知しない**。一覧 RPC は `disclose_to_manager=true` の行だけ返す（今は到達不能だが述語を先に入れる）。

### 10-1. ルール（`pulse_alert_rules` 拡張・seed は code で冪等 upsert）

追加列: `code text unique`／`label text`／`description text`／`source text check (score|behavior|comment) default 'score'`／`notify_immediately boolean default false`／`disclose_to_manager boolean default true`（規則として上長開示を許すか。実際の開示可否は 10-2 のアラート属性で決まる）／`sort_order int`。既存の `type` check（absolute/delta/custom）は **drop** し、`type` は `code` と同じ文字列を入れる（`pulse_alerts.type` も同様に check を drop・`unique(employee_number, cycle_id, type)` は維持＝type=code）。

| code | label | source | params 既定 | 判定（本人×当サイクル） | active | 即時 |
|---|---|---|---|---|---|---|
| `geppo_stormy` | 荒天がある | score | `{"threshold":1}` | 天気4問のいずれかが ≤threshold | ✔ | — |
| `geppo_drop2` | 2段階下落して雨以下 | score | `{"drop":2,"max_after":2}` | いずれかの項目が 前回比 −drop 以上 かつ 今回 ≤max_after | ✔ | — |
| `geppo_rain2` | 雨以下が2項目 | score | `{"threshold":2,"min_items":2}` | ≤threshold の項目が min_items 以上 | ✔ | — |
| `preset_all_cloudy` | 全項目くもり | score | `{"score":3}` | 天気4問すべて =score | ✔ | — |
| `preset_decline_3m` | 3か月連続下降 | score | `{"months":3}` | 直近3回答が暦月連続かつ総合が単調減少（既存クライアント判定を DB 化） | ✔ | — |
| `preset_same_3m` | 3か月同回答 | behavior | `{"months":3}` | 直近3回答が暦月連続かつ天気4問の値が全回同一 | ✔ | — |
| `preset_org_change` | 主務組織の変更 | behavior | `{}` | 今回の `snap_department` ≠ 前回回答の `snap_department`（両方非null） | ✔ | — |
| `preset_unanswered_3m` | 3か月未回答 | behavior | `{"months":3}` | **サイクル単位でのみ判定**: 対象者（pulse_is_target）で、当サイクル＋直前2サイクル（period 連続・いずれも sent/closed）に回答なし。当サイクルが closed か due_date < 今日 のときだけ | ✔ | — |
| `legacy_absolute` | 総合平均が低い（旧） | score | `{"threshold":2}` | 既存 absolute（既存 seed 行を code 付与して更新） | **OFF** | — |
| `legacy_delta` | 総合平均の急降下（旧） | score | `{"drop":1.5}` | 既存 delta（同上） | **OFF** | — |
| `comment_sos` | SOS（自由記述） | comment | `{"category":"SOS"}` | 分類結果 categories に category を含む | ✔ | **✔** |
| `comment_health` | 体調不安（自由記述） | comment | `{"category":"体調不安"}` | 同上 | ✔ | **✔** |
| `comment_relationship` | 人間関係（自由記述） | comment | `{"category":"人間関係"}` | 同上 | ✔ | — |
| `comment_org` | 組織課題（自由記述） | comment | `{"category":"組織課題"}` | 同上 | ✔ | — |
| `comment_evaluation` | 評価（自由記述） | comment | `{"category":"評価"}` | 同上 | ✔ | — |
| `comment_work` | 仕事（自由記述） | comment | `{"category":"仕事"}` | 同上 | OFF | — |
| `comment_career` | キャリア（自由記述） | comment | `{"category":"キャリア"}` | 同上 | OFF | — |
| `comment_private` | プライベート（自由記述） | comment | `{"category":"プライベート"}` | 同上 | OFF | — |
| `comment_admin` | 総務（自由記述） | comment | `{"category":"総務"}` | 同上 | OFF | — |
| `comment_request` | 要望・提言（自由記述） | comment | `{"category":"要望/提言"}` | 同上 | OFF | — |
| `comment_unclassified` | 分類困難（自由記述） | comment | `{"category":"分類困難"}` | 同上 | OFF | — |

- `disclose_to_manager` 既定: score 系＝true（ただし 10-2 の由来カテゴリ判定で最終決定）／behavior 系・comment 系＝**false**（決定1: 対人・コメント由来は人事のみ。主務変更・同回答・未回答は人事の運用情報）。
- ON/OFF・params・notify_immediately・disclose_to_manager は RPC `pulse_update_alert_rule(p_id uuid, p_patch jsonb)`（admin のみ・params は code ごとにキーと型を検証・不正は例外）で変更。code/label/source は変更不可。
- 既存 seed 2行（name `絶対値アラート（平均2以下）`／`変化量アラート（1.5以上の下落）`）は `code` を `legacy_absolute`／`legacy_delta` に付与し `is_active=false` へ更新（name で特定）。

### 10-2. アラート（`pulse_alerts` 拡張）

追加列: `categories text[] not null default '{}'`（判定の由来カテゴリ）／`disclose_to_manager boolean not null default false`／`severity text check (info|warn|critical) not null default 'warn'`／`notified_at timestamptz`／`notified_kind text check (immediate|digest)`／`updated_at timestamptz default now()`。

- `reason` jsonb（ルール別）: 共通 `rule_code`,`rule`(label),`rule_id`。stormy `items:[{category,score}]`／drop2 `items:[{category,prev,cur,prev_period}]`／rain2 `items:[{category,score}]`／all_cloudy `{}`／decline_3m `series:[{period,overall}]`／same_3m `periods:[…],scores:{category:score}`／org_change `{prev_department,department,prev_period}`／unanswered_3m `periods:[…]`／legacy は既存キー維持／comment_* `{category,summary,severity}`（summary は分類の1行要約）。
- **`disclose_to_manager`（行）** ＝ `rule.disclose_to_manager and source='score' and categories ⊆ {仕事,健康,評価}`（total/overall 由来＝4カテゴリ全部を categories に入れる → 対人を含むので false）。
- `severity`: comment_sos/comment_health＝`critical`／stormy・drop2・rain2・decline_3m＝`warn`／その他＝`info`。
- **冪等・再判定**: `on conflict (employee_number, cycle_id, type) do update set reason, categories, severity, disclose_to_manager, updated_at=now()`（status／notified_at／対応は保持）。再判定で **条件を満たさなくなった score/behavior 由来の行は、対応レコードが無く notified_at が null なら delete**（回答修正で消えた誤報を残さない）。comment 由来は分類が更新されるまで残す。

### 10-3. 判定の実行経路（backend）

- 内部 `pulse__evaluate_employee(p_emp text, p_cycle_id uuid) returns jsonb`（**内部専用**・全ロール revoke）: score/behavior/comment の全 active ルールを本人×当サイクルで判定し upsert/delete。返り値 `{"upserted":n,"deleted":n,"immediate_alert_ids":[uuid…]}`（immediate＝今回 **新規 insert** された行のうち rule.notify_immediately=true のもの。既存行の update は含めない）。
- `pulse__submit_response` の末尾（answers 挿入後）で呼ぶ → immediate があれば `pulse__request_immediate(alert_ids)`（10-6）を呼ぶ。コメントが非空なら `pulse__request_classification(response_id)`（10-6）も呼ぶ。**これらは失敗しても回答保存を失敗させない**（`begin … exception when others then null; end` で握る）。
- 公開 `pulse_evaluate_alerts(p_cycle_id uuid) returns integer`（既存シグネチャ・権限維持＝手動「再判定」ボタン）: 当サイクル回答者全員に `pulse__evaluate_employee` ＋ サイクル単位ルール `preset_unanswered_3m`（対象者全員を走査）。返り値＝upserted 合計。
- サイクル単位ルールは日次ダイジェスト実行時（10-6 daily）にも当月 sent サイクルへ走らせる（`pulse_evaluate_cycle_rules(p_cycle_id)`・service_role 専用）。

### 10-4. コメント分類（`pulse_comment_classifications` 新設）

```sql
create table if not exists public.pulse_comment_classifications (
  response_id uuid primary key references public.pulse_responses(id) on delete cascade,
  categories text[] not null default '{}',   -- 11分類の部分集合（1〜3件）
  primary_category text,
  severity text check (severity in ('low','mid','high')),
  summary text,                               -- 60字以内の日本語1行（ダイジェスト用）
  comment_hash text not null,                 -- md5(comment)。本文が変わったら再分類
  model text, classified_at timestamptz not null default now(), error text
);
```
- 11分類の値（固定文字列）: `SOS`・`体調不安`・`人間関係`・`仕事`・`評価`・`キャリア`・`プライベート`・`総務`・`要望/提言`・`組織課題`・`分類困難`。
- RLS: SELECT＝`pulse_is_admin() or (pulse_can_manage_alert() and pulse_scope() = 'all')`。書込ポリシー無し＝service_role 専有（RPC）。**分類結果は人事のみ**（決定5・上長には返さない）。「人事」＝admin か can_manage_alert かつ scope='all' の保有者。scope='own_unit'（上長）は realname/can_manage_alert を持っていても読めない（本番 rollback 試走で own_unit が読める述語を検出して締めた・2026-09-21）。`pulse_list_alerts` の `comment_categories/comment_summary` も同じ条件（scope='all'）でのみ返す。
- RPC（service_role 専用）: `pulse_pending_classifications(p_limit int default 50) returns table(response_id uuid, comment text, weather jsonb, nps int)`（コメント非空で、分類行が無いか comment_hash が不一致のもの。**氏名・社員番号・部署は返さない**）／`pulse_apply_classification(p_response_id uuid, p_categories text[], p_primary text, p_severity text, p_summary text, p_model text) returns jsonb`（upsert → 本人×当サイクルの `pulse__evaluate_employee` → immediate があれば `pulse__request_immediate` → `{"alerts_upserted":n,"immediate_alert_ids":[…]}`）。
- **n<5 の作法**（pulse-summary と同じ趣旨の適用）: ①Claude へ送るのは本文＋天気4値＋eNPS のみ（識別子・部署・氏名を送らない）②分類結果を部署などで集計して見せる面は n<5 を必ずマスク（P2 ではそのような集計面は作らない）③閲覧は上記 RLS で人事のみ。

### 10-5. 対応管理（`pulse_alert_actions` 拡張）

- `state` check を `todo`(未対応)／`doing`(対応中)／`done`(対応済)／`not_needed`(対応不要)／`on_hold_org`(保留(組織課題)) の5値へ拡張。`title text`（対応名）を追加。
- トリガ `pulse_alert_actions_sync_status`（after insert/update/delete）: 親 `pulse_alerts.status` を `state in ('done','not_needed')` なら `closed`、それ以外（行削除含む）なら `open` に同期。**未完了＝ status='open'**（KPI・ダイジェストの分母）。
- RPC: `pulse_bulk_update_alert_actions(p_alert_ids uuid[], p_patch jsonb) returns integer`（最大50件・patch は `title/state/assignee_employee_number/due_date/note` の任意キーのみ反映・各 alert に `pulse_can_manage_alert() and pulse_can_view_employee(本人)` を要求・1行も無ければ upsert で新規作成）／`pulse_delete_alert_action(p_alert_id uuid)`（誤登録の削除＝対応レコードだけ消し、アラートは open に戻る。同じ権限）／`pulse_set_alert_status` は互換で残す（UI からは使わない）。
- `pulse_list_alerts(p_cycle_id uuid)` は **返り値が変わるため drop→create**。`p_cycle_id is null` なら直近12サイクル分をまとめて返す。追加列: `period text`, `rule_code text`, `rule_label text`, `source text`, `categories text[]`, `severity text`, `disclose_to_manager boolean`, `notified_at timestamptz`, `comment_categories text[]`（分類・人事＝realname 権限が無ければ null）, `comment_summary text`（同）, `sum_score int`（当サイクル合計）, `prev_sum_score int`。`action` jsonb に `title` を追加。**呼び出し元が admin でなく `pulse_scope()='own_unit'` の場合は `disclose_to_manager=true` の行だけ**返す（決定1）。並び: open→closed、severity critical→warn→info、created_at desc。

### 10-6. 通知（Edge `pulse-alert-digest`／`pulse-comment-classify`・cron・Vault）

- `pulse_settings` 追加列: `alert_digest_recipients text[] not null default '{}'`／`alert_digest_enabled boolean not null default true`／`alert_immediate_enabled boolean not null default true`。RPC `pulse_update_alert_notify_settings(p_patch jsonb)`（admin のみ・メールは lower/trim・在籍 employees.email に無いものは例外）。
- 内部 `pulse__request_classification(p_response_id uuid)`／`pulse__request_immediate(p_alert_ids uuid[])`（**内部専用**）: Vault `pulse_cron_secret` が無ければ何もしない。あれば `net.http_post` で各 Edge へ（URL は 0050 と同じく関数内定数・`x-cron-secret`・Vault `pulse_anon_key` があれば Authorization も・timeout 60s）。body: classify `{"response_id":…}`／digest `{"mode":"immediate","alert_ids":[…]}`。
- `pulse_cron_fire_alert_digest()`（0050 と同型）: `pulse-alert-digest` へ `{"mode":"daily"}`。`cron.schedule('pulse-alert-digest','10 0 * * *', …)`＝毎日 **09:10 JST**（決定9 の朝の枠。翌1日のサイクル要約は P3 で同じ枠に足す）。
- service_role 専用 RPC: `pulse_alert_digest_batch(p_alert_ids uuid[] default null) returns jsonb`＝`{"recipients":[{"email","name"}],"digest_enabled","immediate_enabled","alerts":[{id,period,employee_number,name,department,rule_code,rule_label,severity,categories,reason,comment_summary,created_at}],"open_total":n,"by_state":{todo,doing,on_hold_org,done,not_needed}}`。`p_alert_ids` null なら `status='open' and notified_at is null` の全件（period 降順）。`pulse_mark_alerts_notified(p_alert_ids uuid[], p_kind text)`。
- **Edge `pulse-alert-digest`**（verify_jwt=false・config.toml）: POST `{mode:"daily"|"immediate"|"preview", alert_ids?}`。認可＝`x-cron-secret` か JWT(`pulse_can_manage_alert`)。preview は JWT のみ（送らずに本文を返す）。
  - daily: ①`pulse-comment-classify` を `{mode:"batch"}` で HTTP 呼び出し（x-cron-secret・取りこぼしの追い付き。失敗しても続行）②当月 sent サイクルに `pulse_evaluate_cycle_rules` ③`pulse_alert_digest_batch()` → alerts 0件なら `{ok, sent:0}` で終了 ④本文を組む（severity 順→ルール別に「氏名（部署）｜由来｜1行理由｜コメント要約」・末尾に「未完了 N件（未対応 a／対応中 b／保留 c）」＋`{APP_URL}/#/pulse/alerts`）⑤recipients へ Slack DM（`_shared/slack.ts`・users.lookupByEmail→chat.postMessage）⑥送信成功が1人以上なら `pulse_mark_alerts_notified(ids,'digest')`。
  - immediate: `pulse_alert_digest_batch(alert_ids)` → `immediate_enabled` が false なら `{ok, sent:0, skipped:"disabled"}`（notified は付けず daily に回す）→ 「【即時】」冒頭で DM → mark 'immediate'。
  - `SLACK_BOT_TOKEN` 未設定＝400 `no_channel_configured`（notified は付けない）。recipients 空＝`{ok, sent:0, skipped:"no_recipients"}`。
- **Edge `pulse-comment-classify`**（verify_jwt=false）: POST `{response_id}` または `{mode:"batch", limit?}`。認可＝`x-cron-secret` か JWT(`pulse_can_manage_alert`)。`ANTHROPIC_API_KEY` 無し＝500 `anthropic_not_configured`。`claude-sonnet-5`・JSON 出力（`{"categories":[…],"primary":"…","severity":"low|mid|high","summary":"…"}`・categories は 11分類の部分集合 1〜3件・不正値は `分類困難` に丸める）→ `pulse_apply_classification`。**識別子を送らない**（10-4）。応答 `{ok, classified:n, alerts_upserted:n, immediate:n}`。

### 10-7. 振り返り・KPI（RPC・authenticated・`pulse_can_manage_alert` ゲート）

- `pulse_alert_kpis(p_period text) returns jsonb`: `{"alerted_employees":n（当月アラートの distinct 本人数）,"open_total":n（全期間 status=open）,"my_open":n（open かつ assignee=呼び出し本人）,"by_state":{…5値・open/closed 問わず当月},"trend":[{period,alerted_employees}]（直近12 period）}`。権限が無ければ `null`。
- `pulse_alert_review(p_period text) returns table(employee_number, name, department, alert_types text[], base_period, base_sum int, latest_period, latest_sum int, delta int, series jsonb, action_state text, action_title text)`: 当月にアラートがある本人ごとに、当月の合計（base）と **その後に回答がある直近サイクル（+3 か月以内）** の合計（latest）・差分。`series`＝base の前後（−2…+3）の `[{period,sum}]`。並び＝delta desc nulls last。name は realname 権限が無ければ null。（Geppo 02 同等・個人詳細（面談ログ・時系列）は既存 `#/pulse/members/:num` へリンク）

### 10-8. フロントエンド

- `src/lib/pulse.ts`: `PulseActionState` 5値＋`ACTION_STATE_LABEL`／`ALERT_RULE_LABEL`（code→label）／`ALERT_SEVERITY_LABEL`／`COMMENT_CATEGORY_LABEL`（11）／`alertReasonSummary(code, reason)` をルール別に整形／`PulseAlertRow` を 10-5 の列へ更新。
- `#/pulse/alerts`（`PulseAlertsPage` 全面改修・`usePulseAlertsStore`）: 期間セレクタに「すべて（直近12か月）」を追加／フィルタ（状態5値・ルール・担当・重要度）／行＝チェックボックス・氏名（部署）・期間・ルール・理由1行・コメント要約チップ（人事）・severity・「上長開示可」バッジ・対応（対応名/状態/担当/期日/メモ）のインライン編集／**一括更新バー**（選択件数・状態/担当/期日/対応名 を入れて「一括更新」）／行の「対応を削除」（誤登録）／「再判定」／CSV（列に rule_label・severity・categories・comment_summary・action title/state を追加）／タブ「振り返り」（`pulse_alert_review`・delta 降順・6点スパークライン・個人詳細リンク）。
- `#/pulse`（ダッシュボード）: 「アラート」パネルを追加（`pulse_alert_kpis`）＝ 4 KPI（アラート発生者数（当月）／組織の対応未完了／あなたの対応未完了／対応状況＝5値の内訳バー）＋12か月の発生者数バー。既存「未対応アラート」カードは `open_total` に置換。
- `#/pulse/admin`（設定）: 「アラートルール」セクション（表: ON/OFF トグル・ラベル・説明・params の数値入力・即時・上長開示 → `pulse_update_alert_rule`）／「アラート通知」セクション（通知先メールのチップ入力・日次 ON/OFF・即時 ON/OFF → `pulse_update_alert_notify_settings`。「ダイジェストを確認」＝Edge preview・「今すぐ送る」＝daily）。
- `#/pulse/comments`: 行にコメント分類チップ（`pulse_comment_classifications` を response_id で直読・RLS で人事以外は 0 行＝チップ非表示）。
- `#/pulse/members/:num`: タイムラインが新 type のラベルを表示できること（`ALERT_RULE_LABEL` フォールバック）。

### 10-9. 受入条件・レビュー観点

- `npx tsc -b` / `npx vite build` green。0051 は本番 DB で `begin; … rollback;` の試走（判定 SQL をテストデータで実行）を通してから push。
- 判定の正しさ: 各ルールを SQL で単体確認（前回の取り方・暦月連続・境界値 ≤/≥・回答修正時の delete）。
- 決定5 準拠: 通知先＝settings の人事メールのみ。上長へ DM する経路が無いこと。`pulse_list_alerts` の own_unit 述語。
- n<5: 分類 RPC が識別子を返さない・分類テーブルの RLS。
- RLS/権限: 新テーブル default-deny・内部関数の revoke・service_role 専用 RPC が authenticated から呼べない。
- 冪等: 再判定の upsert・delete 条件・digest の notified_at・immediate の二重送信防止・cron 登録の `where not exists`・pg_net 失敗が回答保存を巻き込まない。
