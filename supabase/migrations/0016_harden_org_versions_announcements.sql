-- 0016: org_versions / hr_announcements の anon 書込み穴の硬化（P1.5）
--
-- 背景: anon キー（公開JSバンドル同梱）だけで組織図・発令が書き換え可能
-- だったことを実測確認（2026-07-05）。
--   - org_versions: 0008/0010 で is_writer 制限を入れたが、migration 管理外の
--     旧ポリシー（ダッシュボード時代の全公開ポリシー）が残存し OR 評価で
--     素通りしていた。名前が特定できないため pg_policies から機械的に全部
--     drop して作り直す。
--   - hr_announcements: 0014 が「write (all) to anon, authenticated」と
--     意図的に全開へ倒していた（削除不具合の暫定対応）。削除経路は REST で
--     正常確認済みのため、本来のゲートに戻す。
-- 方針: 読取は現状維持（共有リンクの閲覧が匿名 SELECT に依存 = 0008 コメント）。
--       書込みは authenticated かつ is_writer（editor 以上）に限定。
-- アプリは全機能ログイン必須のため正規利用への影響なし。冪等・再実行安全。

-- ── 1. 既存ポリシーを全て drop（管理外の残存ポリシーを含めて一掃） ────
do $$
declare p record;
begin
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'org_versions'
  loop
    execute format('drop policy %I on public.org_versions', p.policyname);
  end loop;
  for p in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'hr_announcements'
  loop
    execute format('drop policy %I on public.hr_announcements', p.policyname);
  end loop;
end $$;

-- ── 2. org_versions: 読取=全員 / 書込み=ログイン済み editor 以上 ──────
create policy "org_versions read (everyone)"
  on public.org_versions for select
  to anon, authenticated
  using (true);

create policy "org_versions write (editor or above)"
  on public.org_versions for all
  to authenticated
  using (public.is_writer(auth.email()))
  with check (public.is_writer(auth.email()));

-- ── 3. hr_announcements: 読取=全員 / 書込み=ログイン済み editor 以上 ──
create policy "hr_announcements read (all)"
  on public.hr_announcements for select
  to anon, authenticated
  using (true);

create policy "hr_announcements write (editor or above)"
  on public.hr_announcements for all
  to authenticated
  using (public.is_writer(auth.email()))
  with check (public.is_writer(auth.email()));

-- ── 4. anon の DML グラントを剥奪（多層防御。SELECT は残す） ──────────
revoke insert, update, delete on public.org_versions from anon;
revoke insert, update, delete on public.hr_announcements from anon;
grant select on public.org_versions to anon, authenticated;
grant select on public.hr_announcements to anon, authenticated;
grant insert, update, delete on public.org_versions to authenticated;
grant insert, update, delete on public.hr_announcements to authenticated;
