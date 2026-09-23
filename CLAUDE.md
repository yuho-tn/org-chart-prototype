# 組織図管理ツール UI/UX検証プロトタイプ（OrgChart Studio）

## 概要
React+React Flow+Zustand。認証=Google OAuth＋SHO-SAN ドメイン制限

## 参照
- Notion: (なし)
- Memory: [[project_org_chart_prototype]]
- Domain: meta
- Status: active
- 担当officer: CEO直轄
- 関連skills: (なし)

## 起動
npm run dev

## 公開URL
https://shosan-talent-hub.vercel.app （2026-07-07 org-chart-prototype→talent-hub にリネーム・本番プライマリ化。旧 org-chart-prototype-azure.vercel.app も存続）

## 人件費管理モジュール（#/labor・機密）
- ナビ導線なし・URL直打ち専用。`laborcost_admins` 許可リスト限定・全 labor_* テーブル default-deny RLS（migration 0037）。
- **アクセス権限は owner/viewer の2段階（migration 0044）**。owner=データ閲覧＋許可リスト編集／viewer=閲覧のみ。UIの「アクセス管理」タブ（owner限定表示）でメール追加/削除/ロール変更可。現 owner=丹野・髙谷。owner0人化はDBトリガで拒否。
- **所属割当はQ（3ヶ月）単位（migration 0047）**。`labor_assignments` の主キーは (person_id, term, half, quarter)。個人別シートは 1Q/2Q（3Q/4Q）を別々に持ち、期中の異動を月次で正しく振り分ける。1Q=2Qが大多数のため「1Q→2Q一括コピー」ボタンあり。計算エンジン(`src/lib/laborCost.ts` computeHalf)は1Q/2Qが同一なら半期一括、異なれば3ヶ月ずつ別所属として計上（ボーナスは半期÷6を維持）。
- **DIV別アクセス限定ページ（#/labor/div/:target・migration 0048）**。全従業員データを見せず、指定した1DIV/プール（SNS DIV・マーケティングDIV・制作DIV・AI DIV・フロントDIV・HR TM・コーポレートTM・開発TM）だけをメールアドレス単位で見せる。付与は「アクセス管理」タブ下部の「DIV別アクセス」（owner限定）。認可判定と集計は `api/labor-div-report.ts`（Vercel serverless・service_role・呼び出し本人のJWT検証）で行い、他DIVのデータはレスポンスに一切含めない（フロントの useLaborCostStore/useEmployeesStore は使わない＝全社データへ触れない設計）。
- 給与seedデータは**絶対にリポジトリへ入れない**（scratchpad/SQLコンソールのみ）。詳細は memory [[project_shosan_labor_cost_tool]]。

## SmartHR 同期と失敗アラート（Edge Function `smarthr-sync` / `smarthr-alert`）
- 従業員マスターの**正は SmartHR**。日次 pg_cron が `smarthr-sync` を起動し `employees` へ upsert（突合キー=`employee_number`・削除しない＝退職は `left_at`）。
- **2026-09-23 事故**：SmartHR 側のサブドメイン改称（`sho-san20220722mk` → `sho-san`）で同期が `400 inactive` を返し続け、失敗は `smarthr_sync_state` に書かれるだけで誰にも届かず、**発見時に従業員マスターが7件ズレていた**（入社3・退職4）。
- **失敗通知（migration 0052・未デプロイ）**：`smarthr-alert` が日次で `error`／`stale`（36h 動いていない＝cron ごと死亡）／`never` を検知し、`app_users` の master/privileged_admin/admin へ Slack DM。同じ原因は1日1回・原因が変われば即時・復旧時に1回。手順は `docs/SMARTHR_SYNC_ALERT_RUNBOOK.md`。
- **「壊れている」の定義は `smarthr_sync_health()` 1本**。画面の赤バッジ（従業員マスターのヘッダ）と Slack 通知が同じ関数を読む。**判定条件を UI 側に書き直さないこと**（2か所に書くと必ず食い違う）。
- ⚠️ **日次同期そのものの cron はどの migration にも無い**（手登録のままバージョン管理外）。`select * from cron.job` で実体を確認すること。
