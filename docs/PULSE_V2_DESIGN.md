# TalentHub パルスサーベイ v2 — 完成形 設計書（実装エージェント向けSSoT）

リポジトリ: /Users/yuho/projects/active/meta/org-chart-prototype（branch: feat/pulse-v2）
スタック: Vite + React + TypeScript + Zustand + Supabase（純クライアントSPA・サーバなし・書込は SECURITY DEFINER RPC 専有）
検証コマンド: `npx tsc -b`（`npx tsc --noEmit`は無効）／`npx vite build`

## 0. ゴール
- 明日から実運用可能：管理者（裕鵬さん）が #/pulse で「状況把握→次アクション」を1画面で完結、社員が #/survey で気持ちよく回答。
- 既知バグ修正＋プライバシー穴の封鎖＋性能・a11y磨き込み。
- デザインは既存 navy デザインシステム（--navy-*, --primary=navy-700）に完全準拠。絵文字スタンプではなく lucide-react アイコンを基本にする（天気5段階の絵文字☀️🌤️☁️🌧️⛈️は既存仕様として維持）。

## 1. 情報設計（確定）
- `#/survey` = 社員向け回答画面（chrome無し・現状維持）。回答フォーム＋「マイパルス」（自分の過去推移）。
- `#/pulse` = パルスのトップ＝管理ダッシュボード（サブナビ: ダッシュボード/メンバー/アラート/コメント/設定）。
- HomePage: 既存パルスカード（全員→#/survey）はそのまま。**追加**: `canAccessPulse(role)` のとき「パルス管理」カード（→ {name:"pulse"}・desc「結果ダッシュボード・サイクル管理」・Icon: Activity）。
- `src/lib/supabase.ts` に `canAccessPulse(role)` を新設（中身は master/privileged_admin。canManagePermissions の目的外流用を解消）。GlobalHeader のパルスタブ表示ゲートをこれに置換。
- App.tsx へのハードガードは**付けない**（pulse_access保有の非adminユーザーを将来締め出さないため）。各管理ページはRLS拒否/空データ時に丁寧な案内を出す。

## 2. バックエンド（migration 0045_pulse_hardening.sql）— 契約
既存RPCの流儀（SECURITY DEFINER・search_path固定・authenticatedへgrant・anon revoke）を0021-0031から踏襲すること。

1. **[重大修正] `pulse_compute_aggregates` 差し替え**（0030版がベース）: total行で n<5 のとき `weather_dist`・`by_category` も**付与しない**（マスク）。既存のavg_overallマスク・enps_n<5マスクは維持。
2. **[中] RLS修正**: `pulse_monthly_aggregates`・`pulse_summaries` の SELECT ポリシーに「`pulse_scope() <> 'self'`」条件を追加（admin は pulse_scope()='all' なので影響なし。scope=self の利用者は全社集計・AI要約を見られない）。
3. **[中] `pulse_list_comments` 差し替え**: コメント個々について「同一 snap_department の scope内回答者数 < 5」なら department を null で返す（コメント本文は返す。既存の全社n<5ブランケット非表示・実名ゲートは維持）。
4. **[中] `pulse_evaluate_alerts` 差し替え**: `on conflict (employee_number, cycle_id, type) do update set reason = excluded.reason`（re-evaluate時にreasonを最新化）。
5. **新RPC `pulse_my_history()`** returns jsonb: ログイン本人（pulse_current_employee_number()）の回答履歴。`[{ "period": "2026-07", "overall": 3.5, "by_category": {"仕事":4, ...}, "nps": 9, "submitted_at": "..." }]` を period 昇順で。対象＝status in ('sent','closed') のサイクルで本人回答が存在するもの。回答なしなら `[]`。本人特定不可なら `null`。権限: authenticated 全員（本人データのみなので安全）。
6. **新RPC `pulse_admin_cycle_stats()`** returns jsonb: `[{ "cycle_id": "...", "responses": 12, "target": 182 }]`（target=在籍者数 employees.left_at is null）。ゲート: `pulse_is_admin() or pulse_can_manage_alert()`、それ以外は例外 `insufficient_privilege`。
7. コメントで `pulse_alert_rules.type='custom'` が evaluate でスキップされる旨を明記（挙動変更なし）。

**Edge Function `pulse-notify`**: SLACK_BOT_TOKEN と RESEND_API_KEY が**両方**未設定なら HTTP 400 `{ error: "no_channel_configured", detail: "SLACK_BOT_TOKEN / RESEND_API_KEY のいずれも未設定です" }` を返す（サイレントno-op根絶）。片方のみ設定時は従来どおり動き、レスポンスの counts に channel別成功/失敗を返す（既存フィールド維持）。

**ドキュメント**: `supabase/functions/PULSE_PROVISIONING.md` を現状に合わせて全面更新（0032適用済み・Edge Functionデプロイ済みを反映）＋ `docs/PULSE_ACTIVATION_RUNBOOK.md` 新設（裕鵬さん向け: ①secrets 6種の投入コマンド ②Slack App作成手順(chat:write, users:read.email) ③Resend登録 ④pg_cron登録SQL ⑤管理画面での有効化→サイクル作成→受付開始→一斉送信の順。コピペ可能なコードブロックで）。

## 3. フロント共通基盤
- **`src/store/usePulseCyclesStore.ts` 新設**: cycles一覧＋selectedPeriod＋loadCycles()＋selectPeriod() を一元管理（staleフラグ・60秒以内の再fetch抑止・`invalidate()`）。usePulseDashStore / usePulseAlertsStore / usePulseCommentsStore / usePulseAdminStore から cycles/selectedPeriod の重複実装を除去しこのstoreを参照。**期間選択が5画面で同期**することが受入条件。
- **`src/components/pulse/usePulseToast.ts` 新設**: `{ toast, showToast(kind,text), clearToast }`。4秒で自動消滅＋クリック消去＋`role="status" aria-live="polite"`（描画は各ページの既存トーストclassを流用する共通コンポーネント `<PulseToast/>` も同ファイルにexport）。全pulseページで置換採用。
- **useRevalidateOnFocus** を #/pulse ダッシュボードに配線（フォーカス復帰でsilent再取得）。
- CSS分離: index.css からパルス関連クラスを抽出し、ページ単位のCSSファイルへ移設（`src/components/pulse/survey.css`（.pulse__）／`pulse-shared.css`（.pdash__ ＝pulse配下5ページ共通chrome）／`admin.css`（.padm__）／`alerts.css`（.palert__ .pcare__）／`comments.css`（.pcmt__）／`members.css`（.pmem__））。各ページ .tsx が自分のcssを import。**`.psub` は評価制度と共有のため index.css に残す**。移設時に重複トークン（#8FACD6→var(--navy-300)、.pulse__q-cat の紫→navy系）を修正。ブレークポイントは 720px に統一（.pulse__のみ480pxも維持可）。

## 4. #/survey（社員向け回答UX）— 完成形
- ヘッダー: 「SHO-SAN TalentHub / パルスサーベイ」小ブランド＋対象月＋締切日（cycle.due_date）。
- フォーム: 設問カード化。**scale型専用UI（1〜5の数値セグメント）を新設**（weather5と分離＝既知バグ修正）。nps型は0〜10＋両端ラベル「0=全く勧めない／10=強く勧める」。回答進捗バー「N問中M問回答済み」（free_textは任意扱いで進捗分母から除外）。未回答で送信→最初の未回答設問へスムーズスクロール＋強調。
- 送信後サンクス画面: チェックアイコン＋「回答を見直す」＋**マイパルス**（pulse_my_history()で自分の総合スコア推移スパークライン＋カテゴリ別最新値＋eNPS推移。1件でも履歴があれば表示）。
- フッター導線: 「ホームへ」（#/）リンク常設。`canAccessPulse(role)`（useAuthStoreのroleを参照）なら「管理ダッシュボードへ」（#/pulse）。not_target画面にサインアウトボタン（useAuthStore.signOut）。
- 初回マウント1フレームの空白（loaded=false&&loading=false）解消。
- モバイル最適化（回答はスマホ前提・タップ領域44px以上・fixed送信バーは不要、カード下送信ボタンで可）。

## 5. #/pulse（ダッシュボード＝トップ）— 完成形
- **ヒーローバー（最上部）**: 選択サイクルの状態を1行で。sent中=「2026-08 受付中 ｜ 回答 123/182（68%）｜ 締切 8/25（あと3日）」＋回答率プログレスバー＋ボタン「リマインド送信」（notify結果を内訳表示）「受付を終了」。closed=「締切済」表示＋集計状態。stats は pulse_admin_cycle_stats()。
- **オンボーディング空状態**: サイクル0件（または全closedで次サイクル未作成）のとき、4ステップチェックリスト（①設問セットを有効化 → ②サイクルを作成 → ③受付開始 → ④一斉送信）を現在地ハイライト付きで表示し、「設定を開く」CTA（#/pulse/admin）。行き止まり禁止。
- **自動集計**: ロード時、選択期間の aggregates が無い or 選択サイクルstatus='sent' なら `pulse_compute_aggregates` を自動実行→silent再取得（RPC権限エラーは黙って無視し表示のみ）。手動「集計を更新」ボタンも維持。
- 指標カード4枚: 回答率／平均スコア（5点満点・前回比±矢印）／eNPS（前回比）／未対応アラート数（クリックで #/pulse/alerts）。
- チャート: 天気分布（5段横棒・凡例）／平均スコア推移／eNPS推移／回答率推移（スパークラインに点・最新値強調・y軸目盛min/max表示）／カテゴリ別平均／Unit別（部署・雇用形態・役職、n<5マスク表示は「n<5」チップ）。計算は useMemo 化。
- AI要約パネル: 生成ボタン→ローディング→本文。ANTHROPIC_API_KEY未設定エラー時は「APIキー未設定です。docs/PULSE_ACTIVATION_RUNBOOK.md 参照」と親切表示。
- CSV出力維持。

## 6. #/pulse/admin（設定）— 完成形
- 最上部に**運用ステッパー**（ダッシュボードと同じ4ステップ・現在地表示・簡潔）。
- サイクル一覧行に**回答進捗**（pulse_admin_cycle_stats: 「123/182・68%」ミニバー）。
- 「一斉送信」「リマインド」: notifyCycle の戻り値（targets / slack成功 / メール成功 / skip）を**トーストと行内結果**に表示。`no_channel_configured` エラー時は「配信チャネル未設定（Runbook参照）。回答URLを手動でSlack投稿してください」＋「回答URLをコピー」ボタン（https://shosan-talent-hub.vercel.app/#/survey）。
- 対象月入力を `type="month"` に。註記「スライス7で追加予定」を削除し、正フロー（受付開始→一斉送信の2段階・受付開始では通知されない）を明記。
- 設問セット「有効化」に確認ダイアログ:「有効化後は設問を編集できません（修正は複製→新版）」。
- QRow / AlertCard の props 再同期問題: 行データの updated_at や id+値 を key に含める等でローカルstateのズレを解消。
- 質問セット複製・並替・削除など既存機能は維持。

## 7. #/pulse/alerts・comments・members — 磨き
- comments: 検索ボックス（本文部分一致）＋部署フィルタ（返却データから動的生成）＋カテゴリ。空状態文言に「プライバシー保護のため少人数の集団は表示されません」を明記。
- alerts: AlertCard 再同期修正・reevaluate 後の反映確認。
- members: MiniSpark を React.memo 化・一覧行 memo 化。
- 全ページ: PulseToast 採用・ローディングを .skl スケルトンに統一・エラーバナー統一。

## 8. 受入条件（実装後に必ず確認）
- `npx tsc -b` green / `npx vite build` green。
- 期間セレクタが ダッシュボード⇄アラート⇄コメント で同期。タブ切替で cycles 再fetchしない（60秒キャッシュ）。
- scale型設問を作った場合に #/survey で数値UIが出る。
- サイクル0件時のダッシュボードにオンボーディングが出て、#/pulse/admin への導線がある。
- 既存機能の非回帰: CSV出力・アラート対応upsert・面談ログ・メンバー推移・AI要約呼び出し・設問セットCRUD。
- migration 0045 は冪等（create or replace / drop policy if exists → create）。0021〜0031で作られた権限モデルを破壊しない。
