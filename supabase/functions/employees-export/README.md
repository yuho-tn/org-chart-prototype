# employees-export Edge Function

TalentHub の従業員マスター（`public.employees`）から**名簿属性のみ**を読み取り専用で
返す Edge Function。予実アプリ（shosan-yojitsu）の `/api/sync-employees` が社員マスタを
取得するために使う（設計: `shosan-yojitsu/docs/DESIGN_jinkenhi_v3.md §4-1`）。

## 契約

- メソッド: `GET`（`OPTIONS` はCORSプリフライトのみ）
- 認証: `x-export-secret` ヘッダを secret `EMPLOYEES_EXPORT_SECRET` と照合。不一致は 403
- 返却: `{ count, employees: [...] }`
  - フィールドは `employee_number / full_name / display_name / email / employment_type / department / hired_at / left_at` のみ
  - **給与・`labor_*`（丹野専用RLS）には一切触れない**
- service_role で `employees` を1000行ページングで全件取得（全307名）。クエリは直列await

## 必要な secret

| secret | 内容 |
|---|---|
| `EMPLOYEES_EXPORT_SECRET` | 予実アプリと共有するエクスポート用シークレット |

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は Edge Function 実行時に既定注入される（設定不要）。

## デプロイ手順（⚠️ 本番反映は裕鵬さん承認後）

> 停止線: 本番デプロイ・secret設定は裕鵬さん承認後に実施する（DESIGN §4-1 停止線）。
> 以下はコマンドの記録であり、このタスクでは実行しない。

```bash
# 1. エクスポート用シークレットを生成して設定（値は安全な乱数）
supabase secrets set EMPLOYEES_EXPORT_SECRET="$(openssl rand -hex 32)"

# 2. Edge Function をデプロイ（JWT検証は使わずヘッダ照合のため --no-verify-jwt）
supabase functions deploy employees-export --no-verify-jwt

# 3. 予実アプリ側にも同じ値を共有（EMPLOYEES_EXPORT_SECRET）。
#    予実側は SUPABASE_FUNCTIONS_URL/employees-export を x-export-secret 付きで叩く
```

## 動作確認（デプロイ後）

```bash
# 正常系（200・count と employees 配列）
curl -s "https://<project-ref>.supabase.co/functions/v1/employees-export" \
  -H "x-export-secret: $EMPLOYEES_EXPORT_SECRET" | jq '.count'

# 認証失敗（403）
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<project-ref>.supabase.co/functions/v1/employees-export" \
  -H "x-export-secret: wrong"

# メソッド不許可（405）
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://<project-ref>.supabase.co/functions/v1/employees-export" \
  -H "x-export-secret: $EMPLOYEES_EXPORT_SECRET"
```
