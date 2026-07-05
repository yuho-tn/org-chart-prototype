-- ─────────────────────────────────────────────────────────────────────
-- 0017_lockdown_anon_access
-- （0016_harden_org_versions_announcements の続き。0016 が org_versions の
--   管理外残存ポリシー一掃と発令の anon 書込み封鎖、本ファイルが読取面の
--   authenticated 限定と GRANT 剥奪を担当）
--
-- 公開SPAバンドルに含まれる anon キーだけで到達できる面を最小化する。
-- 0015 で employees の「書き込み」は power users に絞られたが、
-- 以下が anon に全開のまま残っていた：
--
--   1. employees SELECT      — 0002 "anon read employees" using(true)。
--      従業員マスター（氏名・email・部署・入退社日・career_track）が
--      anon キーだけで全件読める情報漏えい穴。
--   2. hr_announcements ALL  — 0014 "hr_announcements read/write (all)"
--      が to anon, authenticated / using(true)。発令データ（昇格・入退社
--      の個人名入り）を誰でも読み書きできる。
--   3. app_users SELECT      — 0008/0010 "read app_users (everyone)" が
--      ロール指定なし(to public)のため、社内ユーザーの email・ロール・
--      employee_number 一覧が anon で読める。
--
-- 方針：
--   • 読み取りは authenticated（Google OAuth 済 = 社内ドメイン）に限定。
--   • 書き込みは既存アプリのUIゲートと一致するロールへ限定：
--       employees        → is_manager / is_payroll_manager（0015 踏襲、
--                          to を authenticated のみに整理）
--       hr_announcements → is_manager / is_payroll_manager（= UI の
--                          isOrgPowerUser）OR 作成者本人（detail 画面の
--                          canEdit = isOrgPowerUser || isAuthor と一致）
--       app_users        → 既存 "manage app_users (master/admin only)"
--                          のまま（変更なし）
--   • org_versions の anon SELECT は【意図的に維持】。未ログインの
--     共有リンク閲覧（?v=<id> → viewer mode）が依存する製品機能のため。
--     ※残課題として、全バージョンが列挙可能な点は将来 share token 化
--       で絞るのが望ましい（本migrationのスコープ外）。
--   • 共有リンク匿名ビューは useEmployeesStore.refresh() も呼ぶが、
--     employees の anon SELECT grant を残しつつポリシーを外すことで
--     「エラーではなく0件」で静かにデグレードさせる（組織図スナップ
--     ショット自体は org_versions 由来なので描画は壊れない）。
--   • Learning Box のミラー同期は service_role（RLSバイパス・GRANT も
--     service_role に既定付与）経由のため本変更の影響を受けない。
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────

-- ── 1. employees ─────────────────────────────────────────────────────
-- SELECT: authenticated のみ。旧 "anon read employees"（to public）を
-- 落とし、authenticated 向けを作り直す。
drop policy if exists "anon read employees" on public.employees;
drop policy if exists "employees read (authenticated)" on public.employees;
create policy "employees read (authenticated)"
  on public.employees for select
  to authenticated
  using (true);

-- WRITE: 0015 の内容そのまま、対象ロールを authenticated のみに整理
-- （anon は is_manager(null)=false で実質不可だったが、面を消す）。
drop policy if exists "anon write employees" on public.employees;
drop policy if exists "employees write (power users)" on public.employees;
create policy "employees write (power users)"
  on public.employees for all
  to authenticated
  using (public.is_manager(auth.email()) or public.is_payroll_manager(auth.email()))
  with check (public.is_manager(auth.email()) or public.is_payroll_manager(auth.email()));

-- GRANT: anon は select のみ残す（共有ビューの refresh() を 0件成功で
-- 返すため。行は上記ポリシーで一切見えない）。書き込み系は剥奪。
revoke insert, update, delete on public.employees from anon;
grant select on public.employees to anon;
grant select, insert, update, delete on public.employees to authenticated;

-- ── 2. hr_announcements ──────────────────────────────────────────────
drop policy if exists "anon read hr_announcements" on public.hr_announcements;
drop policy if exists "anon write hr_announcements" on public.hr_announcements;
drop policy if exists "hr_announcements read (all)" on public.hr_announcements;
drop policy if exists "hr_announcements write (all)" on public.hr_announcements;
drop policy if exists "hr_announcements read (authenticated)" on public.hr_announcements;
drop policy if exists "hr_announcements write (power users or author)" on public.hr_announcements;
-- 0016 が作った editor 以上の write ポリシーも落とす（本ファイルの
-- power-users-or-author ゲートに一本化。残すと OR 評価で editor が素通り）。
drop policy if exists "hr_announcements write (editor or above)" on public.hr_announcements;

create policy "hr_announcements read (authenticated)"
  on public.hr_announcements for select
  to authenticated
  using (true);

-- UI ゲート：一覧での新規作成 = isOrgPowerUser(master/privileged_admin/
-- admin)、詳細での編集 = isOrgPowerUser || isAuthor。DB もこれに一致させる
-- （作成時は created_by_email に自分の email を入れることを強制）。
create policy "hr_announcements write (power users or author)"
  on public.hr_announcements for all
  to authenticated
  using (
    public.is_manager(auth.email())
    or public.is_payroll_manager(auth.email())
    or lower(coalesce(created_by_email, '')) = lower(coalesce(auth.email(), ''))
  )
  with check (
    public.is_manager(auth.email())
    or public.is_payroll_manager(auth.email())
    or lower(coalesce(created_by_email, '')) = lower(coalesce(auth.email(), ''))
  );

revoke all on public.hr_announcements from anon;
grant select, insert, update, delete on public.hr_announcements to authenticated;

-- ── 3. app_users ─────────────────────────────────────────────────────
-- SELECT を authenticated に限定（ログイン後の自ロール解決・ユーザー管理
-- 画面はすべてセッションありで動くため影響なし）。
-- 書き込みは既存 "manage app_users (master/admin only)"（0010）のまま。
drop policy if exists "read app_users (everyone)" on public.app_users;
drop policy if exists "app_users read (authenticated)" on public.app_users;
create policy "app_users read (authenticated)"
  on public.app_users for select
  to authenticated
  using (true);

revoke all on public.app_users from anon;
grant select, insert, update, delete on public.app_users to authenticated;

-- ── 4. 給与系テーブル（0013）の防御多重化 ────────────────────────────
-- ポリシー自体は is_payroll_manager 限定で健全（監査済）。ただし
-- Supabase の default privileges により anon にもテーブルGRANTが付与
-- されているため、面ごと剥奪しておく（RLS + GRANT の二重防御）。
revoke all on public.grades from anon;
revoke all on public.periods from anon;
revoke all on public.salary_records from anon;
revoke all on public.salary_audit_log from anon;

-- 0015 の新テーブル群も同様（ポリシーは to authenticated 済）。
revoke all on public.employee_profiles from anon;
revoke all on public.employee_confidential from anon;
revoke all on public.position_levels from anon;
revoke all on public.module_permissions from anon;
revoke all on public.permission_grants from anon;
