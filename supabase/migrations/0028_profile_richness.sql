-- 0028_profile_richness
-- P3: 従業員マスターのカルチャー層リッチ化。employee_profiles に以下を追加。
--   • career_rows jsonb [{id,period_from,period_to,body}] … SHO-SAN経歴（行形式・手入力）
--   • specialties jsonb string[]                         … 得意領域タグ（複数）
--   • hobby_tags  jsonb string[]                         … 趣味タグ（複数）
--   • blocks      jsonb [{id,type,...}]                  … 自由プロフィール（ブロックエディタ4型）
-- mbti(text) / strengths(jsonb string[]) は既存列を再利用（型変更なし）。
-- 既存の scalar 列（specialty/hobbies/bio）は温存し、非破壊的に新列へ best-effort 移行する。
-- 人事機密（employee_confidential）は一切変更しない（P3 は UI 撤去のみ・データ/RLS 温存）。
-- RLS・GRANT は 0015 の employee_profiles ポリシー（本人 OR edit_any OR is_manager）を
-- そのまま継承する（列追加なので新規ポリシー不要）。

alter table public.employee_profiles
  add column if not exists career_rows jsonb not null default '[]'::jsonb,
  add column if not exists specialties jsonb not null default '[]'::jsonb,
  add column if not exists hobby_tags  jsonb not null default '[]'::jsonb,
  add column if not exists blocks      jsonb not null default '[]'::jsonb;

-- ── 既存 scalar 値のベストエフォート移行（移行先が空の行のみ・冪等） ──

-- 得意領域: 区切り（、，,・/／・改行）でタグ配列へ分割
update public.employee_profiles
set specialties = coalesce((
  select jsonb_agg(t order by ord)
  from (
    select trim(x) as t, ord
    from unnest(regexp_split_to_array(specialty, '[、,，・/／\n]+')) with ordinality as u(x, ord)
    where trim(x) <> ''
  ) s
), '[]'::jsonb)
where specialty is not null and trim(specialty) <> ''
  and (specialties is null or specialties = '[]'::jsonb);

-- 趣味: 同様
update public.employee_profiles
set hobby_tags = coalesce((
  select jsonb_agg(t order by ord)
  from (
    select trim(x) as t, ord
    from unnest(regexp_split_to_array(hobbies, '[、,，・/／\n]+')) with ordinality as u(x, ord)
    where trim(x) <> ''
  ) s
), '[]'::jsonb)
where hobbies is not null and trim(hobbies) <> ''
  and (hobby_tags is null or hobby_tags = '[]'::jsonb);

-- 自己紹介: bio → 1つの text ブロック（改行温存）
update public.employee_profiles
set blocks = jsonb_build_array(jsonb_build_object(
  'id', gen_random_uuid()::text,
  'type', 'text',
  'text', bio
))
where bio is not null and trim(bio) <> ''
  and (blocks is null or blocks = '[]'::jsonb);
