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
- ナビ導線なし・URL直打ち専用。`laborcost_admins`（yuho_tnのみ）限定・全 labor_* テーブル default-deny RLS（migration 0037）。
- 給与seedデータは**絶対にリポジトリへ入れない**（scratchpad/SQLコンソールのみ）。詳細は memory [[project_shosan_labor_cost_tool]]。
