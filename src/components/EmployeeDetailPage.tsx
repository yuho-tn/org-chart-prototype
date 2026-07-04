import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { useProfilesStore, canEditProfileOf } from "../store/useProfilesStore";
import { useAuthStore } from "../store/useAuthStore";
import { usePayrollStore } from "../store/usePayrollStore";
import { useUiStore } from "../store/useUiStore";
import { useOrgStore } from "../store/useOrgStore";
import { supabase, canAccessPayroll, employeeName } from "../lib/supabase";
import type { ProfileRow, CustomItem } from "../lib/profile";
import type { OrgNode } from "../lib/types";

/**
 * 従業員詳細ページ（route: #/employees/:num）。
 *   • ヘッダ: アバター・氏名・あだ名・部署/役職（マスターから）・グレード
 *     （payroll 閲覧権限がある人にのみ表示）
 *   • 異動歴: org_versions の確定版(is_confirmed) snapshot から自動生成
 *   • カルチャー層: 自己紹介/得意領域/趣味/MBTI/ストレングス/自由項目/写真
 *     — 本人（＋edit_any 権限者/管理者）はインライン編集可
 *   • 人事機密層: view_confidential 権限者にのみ表示・編集
 */

// ── 異動歴: 確定版スナップショットの軽量キャッシュ ─────────────────
// 全従業員で共通のデータなのでモジュールレベルで1回だけ fetch する
// （詳細ページ表示時の lazy fetch ＋ メモ化）。

type ConfirmedVersionLite = {
  id: string;
  name: string;
  confirmed_period: string | null;
  snapshot: { nodes: OrgNode[] } | null;
};

let confirmedVersionsCache: ConfirmedVersionLite[] | null = null;
let confirmedVersionsPromise: Promise<ConfirmedVersionLite[]> | null = null;

async function loadConfirmedVersions(): Promise<ConfirmedVersionLite[]> {
  if (confirmedVersionsCache) return confirmedVersionsCache;
  if (confirmedVersionsPromise) return confirmedVersionsPromise;
  confirmedVersionsPromise = (async () => {
    if (!supabase) return [];
    const { data, error } = await supabase
      .from("org_versions")
      .select("id, name, confirmed_period, snapshot")
      .eq("is_confirmed", true)
      .order("confirmed_period", { ascending: true });
    if (error || !data) return [];
    confirmedVersionsCache = data as ConfirmedVersionLite[];
    return confirmedVersionsCache;
  })().finally(() => {
    confirmedVersionsPromise = null;
  });
  return confirmedVersionsPromise;
}

/** snapshot 内の該当従業員の配属パス（DIV / TM / Unit）を組み立てる。 */
function pathForEmployee(nodes: OrgNode[], employeeNumber: string): string | null {
  const persons = nodes.filter(
    (n) => n.kind === "person" && n.employeeNumber === employeeNumber,
  );
  if (persons.length === 0) return null;
  // 主務（兼務でないノード）を優先する
  const person = persons.find((p) => !p.isConcurrent) ?? persons[0];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segs: string[] = [];
  let cur = person.parentId ? byId.get(person.parentId) : undefined;
  let hops = 0;
  while (cur && hops < 20) {
    if (cur.kind === "department" && cur.category !== "ROOT") segs.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    hops += 1;
  }
  return segs.length > 0 ? segs.join(" / ") : "（直属）";
}

type HistoryEntry = { period: string; versionName: string; path: string };

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

const EMPTY_ITEM = (): CustomItem => ({
  id:
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  label: "",
  value: "",
});

type ProfileDraft = {
  nickname: string;
  specialty: string;
  bio: string;
  hobbies: string;
  mbti: string;
  strengthsText: string;
  custom_items: CustomItem[];
};

function draftFromProfile(p: ProfileRow | undefined): ProfileDraft {
  return {
    nickname: p?.nickname ?? "",
    specialty: p?.specialty ?? "",
    bio: p?.bio ?? "",
    hobbies: p?.hobbies ?? "",
    mbti: p?.mbti ?? "",
    strengthsText: (p?.strengths ?? []).join("、"),
    custom_items: (p?.custom_items ?? []).map((i) => ({ ...i })),
  };
}

export function EmployeeDetailPage({ num }: { num: string }) {
  const navigate = useUiStore((s) => s.navigate);
  const setToast = useOrgStore((s) => s.setToast);
  const currentRole = useAuthStore((s) => s.currentUser?.role);

  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);

  const profiles = useProfilesStore((s) => s.profilesByNumber);
  const confidentials = useProfilesStore((s) => s.confidentialByNumber);
  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const profilesError = useProfilesStore((s) => s.error);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const fetchConfidential = useProfilesStore((s) => s.fetchConfidential);
  const saveProfile = useProfilesStore((s) => s.saveProfile);
  const saveConfidential = useProfilesStore((s) => s.saveConfidential);
  const uploadPhoto = useProfilesStore((s) => s.uploadPhoto);
  const removePhoto = useProfilesStore((s) => s.removePhoto);
  const setAvatar = useProfilesStore((s) => s.setAvatar);
  const ensurePhotoUrls = useProfilesStore((s) => s.ensurePhotoUrls);
  const photoUrls = useProfilesStore((s) => s.photoUrls);
  const can = useProfilesStore((s) => s.can);

  const emp = employees.find((e) => e.employee_number === num);
  const profile = profiles[num];
  const confidential = confidentials[num];

  const canConfidential = can("profiles", "view_confidential");
  const canEdit = canEditProfileOf(num);
  const payrollAllowed = canAccessPayroll(currentRole);

  // ── データロード: 表示時 fetch ＋ フォーカス時再検証（ポーリングなし） ──
  const reload = useCallback(() => {
    if (employees.length === 0) refreshEmployees();
    refreshProfiles();
    // 権限がある時のみ機密層を fetch（RLS 拒否/0行は store 側で静かに無視）
    fetchConfidential(num);
  }, [employees.length, refreshEmployees, refreshProfiles, fetchConfidential, num]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  // ── グレード（payroll 閲覧権限者のみ・salary_records 最新期） ──────
  const payrollLoaded = usePayrollStore((s) => s.loaded);
  const payrollRefresh = usePayrollStore((s) => s.refresh);
  const payrollRecords = usePayrollStore((s) => s.records);
  const payrollPeriods = usePayrollStore((s) => s.periods);
  const payrollGrades = usePayrollStore((s) => s.grades);

  useEffect(() => {
    if (payrollAllowed && !payrollLoaded) payrollRefresh();
  }, [payrollAllowed, payrollLoaded, payrollRefresh]);

  const latestGrade = useMemo(() => {
    if (!payrollAllowed) return null;
    const sortOf = new Map(payrollPeriods.map((p) => [p.code, p.sort_order]));
    let best: { sort: number; grade_code: string } | null = null;
    for (const r of Object.values(payrollRecords)) {
      if (r.employee_number !== num || !r.grade_code) continue;
      const sort = sortOf.get(r.period) ?? -1;
      if (!best || sort > best.sort) best = { sort, grade_code: r.grade_code };
    }
    if (!best) return null;
    const found = best; // 閉包内での null 絞り込み用
    const grade = payrollGrades.find((g) => g.code === found.grade_code);
    return { code: found.grade_code, label: grade?.label ?? null };
  }, [payrollAllowed, payrollRecords, payrollPeriods, payrollGrades, num]);

  // ── 異動歴（確定版のみ・lazy fetch＋メモ化） ────────────────────────
  const [confirmedVersions, setConfirmedVersions] = useState<ConfirmedVersionLite[] | null>(
    confirmedVersionsCache,
  );
  useEffect(() => {
    let cancelled = false;
    loadConfirmedVersions().then((rows) => {
      if (!cancelled) setConfirmedVersions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const history = useMemo<HistoryEntry[]>(() => {
    if (!confirmedVersions) return [];
    // 同一 confirmed_period が複数ある場合は後勝ち（1期1エントリ）
    const byPeriod = new Map<string, HistoryEntry>();
    for (const v of confirmedVersions) {
      if (!v.confirmed_period || !v.snapshot?.nodes) continue;
      const path = pathForEmployee(v.snapshot.nodes, num);
      if (!path) continue;
      byPeriod.set(v.confirmed_period, {
        period: v.confirmed_period,
        versionName: v.name,
        path,
      });
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  }, [confirmedVersions, num]);

  // ── 写真 signed URL ─────────────────────────────────────────────────
  useEffect(() => {
    const paths = (profile?.photos ?? []).map((p) => p.path);
    if (profile?.avatar_path) paths.push(profile.avatar_path);
    if (paths.length > 0) ensurePhotoUrls(paths);
  }, [profile, ensurePhotoUrls]);

  const avatarUrl = profile?.avatar_path ? photoUrls[profile.avatar_path] : undefined;

  // ── カルチャー層 編集フォーム ───────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  function startEdit() {
    setDraft(draftFromProfile(profile));
    setEditing(true);
  }

  async function commitEdit() {
    setSaving(true);
    const strengths = draft.strengthsText
      .split(/[、,，\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 5);
    const res = await saveProfile({
      employee_number: num,
      nickname: draft.nickname.trim() || null,
      specialty: draft.specialty.trim() || null,
      bio: draft.bio.trim() || null,
      hobbies: draft.hobbies.trim() || null,
      mbti: draft.mbti.trim() || null,
      strengths,
      custom_items: draft.custom_items.filter((i) => i.label.trim() || i.value.trim()),
    });
    setSaving(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
      return;
    }
    setEditing(false);
    setToast({ kind: "info", message: "プロフィールを保存しました" });
  }

  function moveItem(idx: number, dir: -1 | 1) {
    setDraft((d) => {
      const items = [...d.custom_items];
      const to = idx + dir;
      if (to < 0 || to >= items.length) return d;
      [items[idx], items[to]] = [items[to], items[idx]];
      return { ...d, custom_items: items };
    });
  }

  async function handlePhotoUpload(file: File) {
    setUploading(true);
    const res = await uploadPhoto(num, file);
    setUploading(false);
    setToast(
      res.ok
        ? { kind: "info", message: "写真を追加しました" }
        : { kind: "error", message: res.reason ?? "アップロードに失敗しました" },
    );
  }

  async function handlePhotoRemove(path: string) {
    const res = await removePhoto(num, path);
    if (!res.ok) setToast({ kind: "error", message: res.reason ?? "削除に失敗しました" });
  }

  async function handleSetAvatar(path: string | null) {
    const res = await setAvatar(num, path);
    if (!res.ok) setToast({ kind: "error", message: res.reason ?? "設定に失敗しました" });
  }

  // ── 機密層 編集 ─────────────────────────────────────────────────────
  const [confEditing, setConfEditing] = useState(false);
  const [confItems, setConfItems] = useState<CustomItem[]>([]);

  function startConfEdit() {
    setConfItems((confidential?.items ?? []).map((i) => ({ ...i })));
    setConfEditing(true);
  }

  async function commitConfEdit() {
    const res = await saveConfidential({
      employee_number: num,
      items: confItems.filter((i) => i.label.trim() || i.value.trim()),
    });
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
      return;
    }
    setConfEditing(false);
    setToast({ kind: "info", message: "機密情報を保存しました" });
  }

  const displayName = emp ? employeeName(emp) : num;
  const initial = displayName.trim()[0]?.toUpperCase() ?? "?";

  return (
    <main className="page empdetail">
      <div className="page__header">
        <div>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => navigate({ name: "employees" })}
          >
            ‹ 従業員マスターへ戻る
          </button>
        </div>
      </div>

      {profilesError && <p className="versions__error">{profilesError}</p>}

      {!emp && profilesLoaded && employees.length > 0 && (
        <p className="versions__error">
          社員番号 <code>{num}</code> の従業員が見つかりません。
        </p>
      )}

      {/* ── ヘッダカード ─────────────────────────────────────────── */}
      <section className="empdetail__hero">
        <div className="empdetail__avatar" aria-hidden>
          {avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="empdetail__avatarInitial">{initial}</span>
          )}
        </div>
        <div className="empdetail__heroBody">
          <h1 className="empdetail__name">
            {displayName}
            {profile?.nickname && (
              <span className="empdetail__nickname">（{profile.nickname}）</span>
            )}
          </h1>
          <p className="empdetail__meta">
            <span className="emppage__chip">{emp?.department ?? "部署未設定"}</span>
            <span className="emppage__chip">{emp?.position_title ?? "役職未設定"}</span>
            {latestGrade && (
              <span
                className="emppage__chip empdetail__gradeChip"
                title={`最新期の等級${latestGrade.label ? `：${latestGrade.label}` : ""}（給与・査定権限者のみ表示）`}
              >
                等級 {latestGrade.code}
              </span>
            )}
          </p>
          <p className="empdetail__metaSub">
            社員番号 <code>{num}</code>
            {emp?.employment_type && <> ／ {emp.employment_type}</>}
            {emp?.hired_at && <> ／ 入社 {fmtDate(emp.hired_at)}</>}
          </p>
        </div>
        <div className="empdetail__heroActions">
          {canEdit && !editing && (
            <button className="btn btn--primary" onClick={startEdit}>
              プロフィールを編集
            </button>
          )}
        </div>
      </section>

      {/* ── 異動歴（確定版から自動生成・手入力なし） ────────────────── */}
      <section className="empdetail__section">
        <h2 className="empdetail__sectionTitle">異動歴</h2>
        {confirmedVersions === null ? (
          <p className="empdetail__empty">読み込み中…</p>
        ) : history.length === 0 ? (
          <p className="empdetail__empty">
            確定済みの組織図に配置履歴がありません。
          </p>
        ) : (
          <ol className="empdetail__history">
            {history.map((h, i) => (
              <li key={h.period} className="empdetail__historyRow">
                <span className="empdetail__historyPeriod">{h.period}</span>
                <span className="empdetail__historyPath">{h.path}</span>
                {i < history.length - 1 && (
                  <span className="empdetail__historyArrow" aria-hidden>→</span>
                )}
              </li>
            ))}
          </ol>
        )}
        <p className="empdetail__hint">
          ※ FIX登録済みの組織図（確定版）から自動生成しています。
        </p>
      </section>

      {/* ── カルチャー層 ───────────────────────────────────────────── */}
      <section className="empdetail__section">
        <div className="empdetail__sectionHead">
          <h2 className="empdetail__sectionTitle">プロフィール</h2>
          {editing && (
            <div className="empdetail__sectionActions">
              <button className="btn btn--primary btn--xs" onClick={commitEdit} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </button>
              <button className="btn btn--ghost btn--xs" onClick={() => setEditing(false)}>
                取消
              </button>
            </div>
          )}
        </div>

        {!editing ? (
          <dl className="empdetail__fields">
            <ProfileField label="自己紹介" value={profile?.bio} multiline />
            <ProfileField label="得意領域" value={profile?.specialty} />
            <ProfileField label="趣味" value={profile?.hobbies} />
            <ProfileField label="MBTI" value={profile?.mbti} />
            <div className="empdetail__field">
              <dt>ストレングスファインダー</dt>
              <dd>
                {(profile?.strengths ?? []).length > 0 ? (
                  (profile?.strengths ?? []).map((s, i) => (
                    <span key={i} className="emppage__chip">{i + 1}. {s}</span>
                  ))
                ) : (
                  <span className="empdetail__empty">未設定</span>
                )}
              </dd>
            </div>
            {(profile?.custom_items ?? []).map((item) => (
              <ProfileField key={item.id} label={item.label} value={item.value} multiline />
            ))}
          </dl>
        ) : (
          <div className="empdetail__form">
            <label className="empdetail__formRow">
              <span className="field__label">あだ名</span>
              <input
                className="field__input"
                value={draft.nickname}
                onChange={(e) => setDraft({ ...draft, nickname: e.target.value })}
                placeholder="例: ゆーほー"
              />
            </label>
            <label className="empdetail__formRow">
              <span className="field__label">自己紹介</span>
              <textarea
                className="field__input"
                rows={4}
                value={draft.bio}
                onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
              />
            </label>
            <label className="empdetail__formRow">
              <span className="field__label">得意領域</span>
              <input
                className="field__input"
                value={draft.specialty}
                onChange={(e) => setDraft({ ...draft, specialty: e.target.value })}
                placeholder="例: BtoBマーケ戦略 / SEO"
              />
            </label>
            <label className="empdetail__formRow">
              <span className="field__label">趣味</span>
              <input
                className="field__input"
                value={draft.hobbies}
                onChange={(e) => setDraft({ ...draft, hobbies: e.target.value })}
              />
            </label>
            <label className="empdetail__formRow">
              <span className="field__label">MBTI</span>
              <input
                className="field__input"
                value={draft.mbti}
                onChange={(e) => setDraft({ ...draft, mbti: e.target.value })}
                placeholder="例: ENTJ"
              />
            </label>
            <label className="empdetail__formRow">
              <span className="field__label">ストレングスファインダー上位5（読点区切り）</span>
              <input
                className="field__input"
                value={draft.strengthsText}
                onChange={(e) => setDraft({ ...draft, strengthsText: e.target.value })}
                placeholder="例: 達成欲、未来志向、戦略性、最上志向、活発性"
              />
            </label>

            <div className="empdetail__formRow">
              <span className="field__label">自由項目</span>
              {draft.custom_items.map((item, idx) => (
                <div key={item.id} className="empdetail__itemRow">
                  <input
                    className="field__input field__input--xs"
                    placeholder="項目名（例: 好きな言葉）"
                    value={item.label}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        custom_items: d.custom_items.map((it) =>
                          it.id === item.id ? { ...it, label: e.target.value } : it,
                        ),
                      }))
                    }
                    style={{ flex: "0 0 180px" }}
                  />
                  <input
                    className="field__input field__input--xs"
                    placeholder="内容"
                    value={item.value}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        custom_items: d.custom_items.map((it) =>
                          it.id === item.id ? { ...it, value: e.target.value } : it,
                        ),
                      }))
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => moveItem(idx, -1)}
                    disabled={idx === 0}
                    title="上へ"
                  >
                    ↑
                  </button>
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => moveItem(idx, 1)}
                    disabled={idx === draft.custom_items.length - 1}
                    title="下へ"
                  >
                    ↓
                  </button>
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() =>
                      setDraft((d) => ({
                        ...d,
                        custom_items: d.custom_items.filter((it) => it.id !== item.id),
                      }))
                    }
                    title="削除"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="btn btn--ghost btn--xs"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    custom_items: [...d.custom_items, EMPTY_ITEM()],
                  }))
                }
              >
                ＋項目を追加
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ── 写真ギャラリー ─────────────────────────────────────────── */}
      <section className="empdetail__section">
        <div className="empdetail__sectionHead">
          <h2 className="empdetail__sectionTitle">写真</h2>
          {canEdit && (
            <div className="empdetail__sectionActions">
              <label className="btn btn--ghost btn--xs" style={{ cursor: "pointer" }}>
                {uploading ? "アップロード中…" : "＋写真を追加"}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handlePhotoUpload(f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          )}
        </div>
        {(profile?.photos ?? []).length === 0 ? (
          <p className="empdetail__empty">写真はまだありません。</p>
        ) : (
          <div className="empdetail__photos">
            {(profile?.photos ?? []).map((p) => (
              <figure key={p.path} className="empdetail__photo">
                {photoUrls[p.path] ? (
                  <img src={photoUrls[p.path]} alt={p.caption ?? ""} loading="lazy" />
                ) : (
                  <div className="empdetail__photoLoading">…</div>
                )}
                {p.caption && <figcaption>{p.caption}</figcaption>}
                {canEdit && (
                  <div className="empdetail__photoActions">
                    {profile?.avatar_path === p.path ? (
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => handleSetAvatar(null)}
                        title="アバター解除"
                      >
                        ★ アバター
                      </button>
                    ) : (
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => handleSetAvatar(p.path)}
                      >
                        アバターに設定
                      </button>
                    )}
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => handlePhotoRemove(p.path)}
                    >
                      削除
                    </button>
                  </div>
                )}
              </figure>
            ))}
          </div>
        )}
      </section>

      {/* ── 人事機密層（権限者のみ） ─────────────────────────────────── */}
      {canConfidential && (
        <section className="empdetail__section empdetail__section--confidential">
          <div className="empdetail__sectionHead">
            <h2 className="empdetail__sectionTitle">人事機密情報 🔒</h2>
            <div className="empdetail__sectionActions">
              {!confEditing ? (
                <button className="btn btn--ghost btn--xs" onClick={startConfEdit}>
                  編集
                </button>
              ) : (
                <>
                  <button className="btn btn--primary btn--xs" onClick={commitConfEdit}>
                    保存
                  </button>
                  <button className="btn btn--ghost btn--xs" onClick={() => setConfEditing(false)}>
                    取消
                  </button>
                </>
              )}
            </div>
          </div>
          <p className="empdetail__hint">
            このセクションは権限者（役職レベル・個別付与・管理者）にのみ表示されます。
          </p>
          {!confEditing ? (
            (confidential?.items ?? []).length === 0 ? (
              <p className="empdetail__empty">登録された機密項目はありません。</p>
            ) : (
              <dl className="empdetail__fields">
                {(confidential?.items ?? []).map((item) => (
                  <ProfileField key={item.id} label={item.label} value={item.value} multiline />
                ))}
              </dl>
            )
          ) : (
            <div className="empdetail__form">
              {confItems.map((item) => (
                <div key={item.id} className="empdetail__itemRow">
                  <input
                    className="field__input field__input--xs"
                    placeholder="項目名（例: 緊急連絡先）"
                    value={item.label}
                    onChange={(e) =>
                      setConfItems((items) =>
                        items.map((it) =>
                          it.id === item.id ? { ...it, label: e.target.value } : it,
                        ),
                      )
                    }
                    style={{ flex: "0 0 180px" }}
                  />
                  <input
                    className="field__input field__input--xs"
                    placeholder="内容"
                    value={item.value}
                    onChange={(e) =>
                      setConfItems((items) =>
                        items.map((it) =>
                          it.id === item.id ? { ...it, value: e.target.value } : it,
                        ),
                      )
                    }
                    style={{ flex: 1 }}
                  />
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() =>
                      setConfItems((items) => items.filter((it) => it.id !== item.id))
                    }
                    title="削除"
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => setConfItems((items) => [...items, EMPTY_ITEM()])}
              >
                ＋項目を追加
              </button>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function ProfileField({
  label,
  value,
  multiline,
}: {
  label: string;
  value: string | null | undefined;
  multiline?: boolean;
}) {
  return (
    <div className="empdetail__field">
      <dt>{label}</dt>
      <dd style={multiline ? { whiteSpace: "pre-wrap" } : undefined}>
        {value?.trim() ? value : <span className="empdetail__empty">未設定</span>}
      </dd>
    </div>
  );
}
