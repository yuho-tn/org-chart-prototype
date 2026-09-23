-- ══════════════════════════════════════════════════════════════════════
-- 0046_labor_exec_cost_alloc.sql
-- 人件費モジュール（#/labor）: 役員コストを各DIVへ配賦する（裕鵬さん確定 2026-08-16）。
--
-- 背景:
--   0039 で「役員」を独立 dept（treatment='product' / div='役員'）として新設したが、
--   このDIVは labor_front_targets を持たないため按分を一切受けず・与えず、
--   全社総計には入るが売上4DIVには一切乗らない孤立DIVになっていた。
--   実測（2026-08-16・本番データ）: 役員DIV 年計 8,867.4万円が売上4DIVに未計上。
--
-- 変更（5期・H1/H2 両方）:
--   髙谷・丹野・赤穂 → フロントDIV（alloc_group='front'）へ全額
--   LEE             → 開発TM（alloc_group='overhead'）へ全額
--   いずれも tm=null / kenmu_rate=0 / kenmu_dept=null（丹野の旧30%兼務は既に解消済）。
--
--   dept_map・labor_tms の「役員」行は残す（元に戻せる状態を維持・裕鵬さん指示）。
--   付替え後の役員DIVはメンバー0で全ゼロ行として表示される。
--
-- あわせて（同じく2026-08-16 裁定）:
--   TM未割当のまま残っていた4名を ALLOC_TM（売上目標比で按分）へ変更し、
--   所属DIV内の各TMへ自動配分させる。PL連携時に送り先の無い金額（年計2,286.5万円）を
--   無くすため。制作はTM目標が未設定のため均等割（=PL側の制作50:50と同挙動）になる。
--
-- ⚠ 計算エンジン（laborCost.ts）は変更しない。所属データの付替えのみで按分に乗る。
-- 検証（実測で確認すること）:
--   ・全社総計 grandTotalByMonth は不変（役員は元々総計に入っていたため増えない）
--   ・フロントDIVプール＋開発TMプールの増分の和 == 旧役員DIV総額（金額保存）
--   ・unmappedDepts が空 / 未配分残差 0
-- ══════════════════════════════════════════════════════════════════════

begin;

-- ── 0. バックアップ（元に戻せる状態を必ず先に作る）────────────────────
create table if not exists public.labor_assignments_bak_20260816 as
  select * from public.labor_assignments where term = '5';

-- ── 1. 役員 → フロントDIV / 開発TM へ付替え（H1・H2 両方）───────────
update public.labor_assignments a
   set dept = case when p.name = 'LEE' then '開発TM' else 'フロントDIV' end,
       tm = null,
       kenmu_dept = null,
       kenmu_tm = null,
       kenmu_rate = 0
  from public.labor_people p
 where p.id = a.person_id
   and a.term = '5'
   and a.dept = '役員';

-- ── 2. TM未割当4名を「（売上目標比で按分）」へ（DIV内TMへ自動配分）──
update public.labor_assignments a
   set tm = '（売上目標比で按分）'
  from public.labor_people p
 where p.id = a.person_id
   and a.term = '5'
   and a.dept in ('制作DIV', 'AI DIV')
   and a.tm is null
   and p.name in ('可貫', '伊藤（5%）', '太目', '高橋良一（8%）');

commit;

-- ── 3. 兼務先TM未指定の残り（中川：フロントDIV所属・AI DIV へ50%兼務）──
-- 所属側のTM未割当と同じ性質（兼務先DIVに落ちるがTMが無く送り先不明）。
-- 実測で年計590.9万円がここに残っていたため、同じ扱い（目標比按分）に揃える。
begin;

update public.labor_assignments a
   set kenmu_tm = '（売上目標比で按分）'
  from public.labor_people p
 where p.id = a.person_id
   and a.term = '5'
   and a.kenmu_dept in ('制作DIV', 'AI DIV')
   and a.kenmu_tm is null
   and a.kenmu_rate > 0;

commit;
