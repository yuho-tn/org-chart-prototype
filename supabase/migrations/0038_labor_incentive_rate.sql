-- ─────────────────────────────────────────────────────────────────────
-- 0038_labor_incentive_rate
--
-- フロント陣のインセンティブ掛け率（売上に対する%）を labor_people に
-- 正式なデータとして保持する。元シートでは名前欄の「（8%）」等の注記
-- だったものを構造化（2026-07-17 裕鵬さん指示）。
-- 値の投入はシート注記から別途 UPDATE（migration には含めない）。
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

alter table public.labor_people
  add column if not exists incentive_rate numeric;

comment on column public.labor_people.incentive_rate is
  'インセンティブの売上に対する掛け率（0.05 = 5%）。フロント陣のみ。null = 対象外';
