-- ══════════════════════════════════════════════════════════════════════
-- 0039_labor_taxonomy_5th.sql
-- 人件費モジュール（#/labor）: 5期のDIV/TM構成を新体系へ差し替える。
--
-- 新体系（裕鵬さん確定 2026-07-27）:
--   SNS DIV            (product・TMなし＝DIV直計上)
--   マーケティングDIV  (product・TM: 広告TM / AIO TM)
--   制作DIV            (product・TMなし)
--   AI DIV             (product・TM: BAA Unit / AXコンサルUnit)
--   フロントDIV        (front・売上目標比で他DIVへ按分＝従来維持)
--   コーポレートTM     (corporate・按分対象外)
--   HR TM             (product・front_target無し＝按分を受けない独立DIV)
--   役員               (product・按分を受けない。TM: 代表取締役 / 執行役員)
--
-- 適用範囲: 5期のみ（labor_dept_map/labor_front_targets は term='5'）。
-- labor_tms はグローバル表だが実質5期出力専用のため全面差し替え。
-- 1〜4期の dept_map 行・assignments には手を触れない。
--
-- ⚠ この migration は「既存6 deptの1:1リネーム（機械的）」まで行う。
--    HR TM・役員へのメンバー割当、および AI/役員 のTM再割当は
--    データ実体の判断が要るため設定タブ/個人別シートで手動（裕鵬さん）。
-- ══════════════════════════════════════════════════════════════════════

begin;

-- ── 0. labor_dept_map に表示順カラムを追加（DIV並び順の正） ──────────
alter table public.labor_dept_map
  add column if not exists sort_order int not null default 0;

-- ── 1. 5期 dept_map を新体系へ差し替え ───────────────────────────────
delete from public.labor_dept_map where term = '5';

insert into public.labor_dept_map (term, dept, div, treatment, sort_order) values
  ('5', 'SNS DIV',        'SNS DIV',        'product',   1),
  ('5', 'マーケティングDIV', 'マーケティングDIV', 'product', 2),
  ('5', '制作DIV',        '制作DIV',        'product',   3),
  ('5', 'AI DIV',         'AI DIV',         'product',   4),
  ('5', 'フロントDIV',    null,             'front',     5),
  ('5', 'コーポレートTM', null,             'corporate', 6),
  ('5', 'HR TM',          'HR TM',          'product',   7),
  ('5', '役員',           '役員',           'product',   8);

-- ── 2. 既存5期 assignments の dept/kenmu_dept を1:1リネーム ───────────
-- 旧dept名（0037seed）→ 新dept名。給与額(labor_amounts)には触れない。
do $$
declare
  m record;
begin
  for m in
    select * from (values
      ('SNSDIV',      'SNS DIV'),
      ('WEBマーケTM', 'マーケティングDIV'),
      ('制作TM',      '制作DIV'),
      ('AI',          'AI DIV'),
      ('フロント',    'フロントDIV'),
      ('コーポレート', 'コーポレートTM')
    ) as t(old, new)
  loop
    update public.labor_assignments set dept = m.new
      where term = '5' and dept = m.old;
    update public.labor_assignments set kenmu_dept = m.new
      where term = '5' and kenmu_dept = m.old;
  end loop;
end $$;

-- ── 3. TMマスターを新体系へ全面差し替え ──────────────────────────────
-- 旧TM（SNS_インスタ運用TM 等）は廃止。マーケの「広告TM」は名称一致で存続。
-- 旧「AIOTM」は「AIO TM」へ寄せる（下の assignments リネームで追随）。
delete from public.labor_tms;

insert into public.labor_tms (tm, div, sort_order) values
  ('広告TM',       'マーケティングDIV', 1),
  ('AIO TM',       'マーケティングDIV', 2),
  ('BAA Unit',     'AI DIV',            3),
  ('AXコンサルUnit', 'AI DIV',          4),
  ('代表取締役',   '役員',              5),
  ('執行役員',     '役員',              6);

-- ── 4. 既存5期 assignments の tm を新体系へ整合 ──────────────────────
-- 新TMに一致するもの（広告TM／AIOTM→AIO TM）は維持・寄せ。
-- それ以外（旧SNS/制作/AITM 等）は null に戻し、設定タブで再割当（手動）。
update public.labor_assignments set tm = 'AIO TM'
  where term = '5' and tm = 'AIOTM';
update public.labor_assignments set tm = null
  where term = '5'
    and tm is not null
    and tm not in (select tm from public.labor_tms);

-- ── 5. フロント按分の分母（5期・DIV別売上目標）を新DIV名で再seed ─────
-- 値は 0037 と同一（「5期 営業別・DIV別売上計画」上期/下期サマリより）。
delete from public.labor_front_targets where term = '5';

insert into public.labor_front_targets (term, half, div, sales_target) values
  ('5', 'H1', 'SNS DIV',        15448),
  ('5', 'H1', 'マーケティングDIV', 13107),
  ('5', 'H1', '制作DIV',        11700),
  ('5', 'H1', 'AI DIV',          8671),
  ('5', 'H2', 'SNS DIV',        17552),
  ('5', 'H2', 'マーケティングDIV', 14893),
  ('5', 'H2', '制作DIV',        13300),
  ('5', 'H2', 'AI DIV',         11329);

commit;

-- ── 適用後の手動タスク（裕鵬さん・アプリUI上）─────────────────────────
--  1. 個人別シート: HR TM・役員 の該当者に所属を割当。
--     役員の丹野は kenmu_rate=0（全額計上）で 役員 に割当（旧30%兼務を解除）。
--  2. 設定タブ TM割当: マーケ→広告/AIO、AI→BAA/AXコンサル、役員→代表/執行 を割当。
--     （SNS/制作/HR はTMなし＝DIV直計上で割当不要）
--  3. 役員・HR TM のメンバーの金額データ投入（未計上なら個人別シートで入力）。
