-- ══════════════════════════════════════════════════════════════════════
-- 0041_labor_manual_rows.sql
-- 人件費モジュール（#/labor）: 見立て（手動）行の概念を追加（裕鵬さん 2026-07-27）。
--
-- ・マスター連携行（employee_number 有）＝社員。削除不可。
-- ・手動行（is_manual=true）＝見立てコスト用。追加/削除/編集可。
-- ・未連携かつ手動でない行（旧退職者などのノイズ）は個人別シートで非表示にする
--   （破壊せず hide。1〜4期の履歴は保持）。
--
-- 既存の未連携7名のうち、5期に計上がある3名（入社前/外注の見立て）は
-- is_manual=true に転換して残し、残り4名（5期計上ゼロ）は未連携のまま＝非表示。
-- ══════════════════════════════════════════════════════════════════════

begin;

alter table public.labor_people
  add column if not exists is_manual boolean not null default false;

comment on column public.labor_people.is_manual is
  '手動追加の見立て行（マスター未登録・追加/削除/編集可）。マスター連携行(employee_number有)はfalse。';

-- 未連携かつ5期に計上のある人＝見立て行として手動フラグ化（表示・編集・削除可に）
update public.labor_people set is_manual = true
  where employee_number is null
    and id in (
      select distinct person_id from public.labor_amounts
      where term = '5' and amount <> 0
    );

commit;
