# 人件費モジュール migration 0039＋0040 適用ランブック

対象: 5期のDIV/TM再編（0039）＋間接費按分2グループ化（0040）。
実行者: 裕鵬さん（`labor_*` は laborcost_admins 専用RLS）。
実行先: talent-hub 側 Supabase（ref `ubdrcmydhcuifqmieqmk`）SQLエディタ。

金額データ（`labor_amounts`）は不変。migrationは `labor_dept_map` / `labor_tms` /
`labor_front_targets` と、5期 `labor_assignments` の所属/TMの1:1リネームのみ変更する。

---

## STEP 0. 安全バックアップ（推奨・1回）

```sql
create table if not exists labor_assignments_bak_20260727 as
  select * from public.labor_assignments where term = '5';
```

## STEP 1 → 2. migration を順に全文実行

1. `supabase/migrations/0039_labor_taxonomy_5th.sql` を丸ごと実行
2. `supabase/migrations/0040_labor_overhead_alloc.sql` を丸ごと実行

両ファイルとも `begin; … commit;` で囲まれており、失敗時はロールバックされる。
必ず 0039 → 0040 の順で。

## STEP 3. 適用後の検証クエリ

```sql
-- ① dept_map 5期＝9行・treatment/alloc_group が想定どおり
select dept, div, treatment, sort_order, alloc_group
  from public.labor_dept_map where term = '5' order by sort_order;
--   SNS DIV/マーケティングDIV/制作DIV/AI DIV = product
--   フロントDIV = front / alloc_group=front
--   コーポレートTM / HR TM / 開発TM = front / alloc_group=overhead
--   役員 = product

-- ② TMマスター＝6行
select tm, div, sort_order from public.labor_tms order by sort_order;
--   広告TM・AIO TM（マーケ）/ BAA Unit・AXコンサルUnit（AI）/ 代表取締役・執行役員（役員）

-- ③ front_targets 5期＝8行（H1/H2 × SNS/マーケ/制作/AI）
select half, div, sales_target from public.labor_front_targets
  where term = '5' order by half, div;

-- ④ 未マッピング所属がゼロ（あれば集計漏れ＝要再割当）
select distinct dept from public.labor_assignments
  where term = '5' and dept is not null
    and dept not in (select dept from public.labor_dept_map where term = '5');

-- ⑤ 無効TM参照がゼロ
select distinct tm from public.labor_assignments
  where term = '5' and tm is not null
    and tm not in (select tm from public.labor_tms);
```

④⑤が空ならクリーン。行が出たら、その所属/TMは個人別シートで割当し直す。

## STEP 4. 本番デプロイ

PR #3 を `feature/employees-export` へマージ → Vercel 本番反映（既存フロー）。

## STEP 5. アプリUI上の手動データ作業（#/labor）

1. **開発TM**: 開発メンバーの所属を個人別シートで「制作DIV → 開発TM」に変更
   （HR・コーポは所属そのままで按分対象化済み・変更不要）。
2. **役員**: 丹野を「兼務率0で役員」に割当（旧30%兼務を解除＝全額計上）。
   髙谷/LEE/赤穂も役員へ。
3. **設定タブ TM割当**: マーケ→広告/AIO、AI→BAA/AXコンサル、役員→代表/執行。
   （SNS/制作/HR はTMなし＝DIV直計上で対象外）。
4. **金額投入**: 役員・HR・開発の金額が未計上なら個人別シートで入力。
5. **確認**: DIV按分タブで「総計＝各原資＋プロダクト」が合うか、④の未割当警告が
   出ていないかを目視。

## ロールバック（緊急時）

```sql
-- assignments を戻す（STEP 0 のバックアップ前提）
update public.labor_assignments a
  set dept = b.dept, kenmu_dept = b.kenmu_dept, tm = b.tm
  from labor_assignments_bak_20260727 b
  where a.person_id = b.person_id and a.term = b.term and a.half = b.half;
-- dept_map / tms / front_targets は 0037/0039 の seed を再適用して復元する。
```
