import { useCallback, useEffect, useMemo, useState } from "react";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { useProfilesStore, canEditProfileOf } from "../store/useProfilesStore";
import { useAuthStore } from "../store/useAuthStore";
import { usePayrollStore } from "../store/usePayrollStore";
import { useUiStore } from "../store/useUiStore";
import { useOrgStore } from "../store/useOrgStore";
import { supabase, canAccessPayroll, employeeName } from "../lib/supabase";
import { avatarPathOf } from "../lib/profile";
import type { ProfileRow, CareerRow } from "../lib/profile";
import type { OrgNode } from "../lib/types";
import {
  MBTI_TYPES,
  MBTI_BY_CODE,
  MBTI_GROUP_ORDER,
  MBTI_GROUP_LABEL,
  MBTI_GROUP_COLOR,
  mbtiAvatarDataUri,
  mbtiExternalUrl,
  normalizeMbti,
} from "../lib/mbti";
import {
  STRENGTHS,
  STRENGTH_BY_ID,
  STRENGTH_DOMAIN_LABEL,
  STRENGTH_DOMAIN_COLOR,
  normalizeStrengthIds,
  type StrengthDomain,
} from "../lib/strengths";
import {
  normalizeBlocks,
  pruneBlocks,
  emptyBlock,
  collectBlockImagePaths,
  BLOCK_TYPE_LABEL,
  URL_REGEX,
  type ProfileBlock,
  type BlockType,
} from "../lib/profileBlocks";

/**
 * 従業員詳細ページ（route: #/employees/:num）。P3 でカルチャー層を刷新。
 *   • ヘッダ: アバター・氏名・あだ名・部署/役職・グレード（payroll 権限者のみ）
 *   • SHO-SAN経歴: 行形式の自由入力（旧・自動異動歴は初期値として取込可）
 *   • 得意領域/趣味: タグ複数／MBTI: 16タイプ選択＋アバター／ストレングス: 34資質から5つ順位
 *   • 自由プロフィール: 軽量ブロックエディタ（見出し/テキスト/画像/リンク）
 *   • 写真ギャラリー（非回帰）
 *   • 人事機密層は UI 撤去（データ・RLS は温存。ここでは一切描画しない）
 */

// ── 異動歴（初期値変換用）: 確定版スナップショットの軽量キャッシュ ──────
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

type HistoryEntry = { period: string; path: string };

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── 統一編集ドラフト ───────────────────────────────────────────────────
type ProfileDraft = {
  nickname: string;
  careerRows: CareerRow[];
  specialties: string[];
  hobbyTags: string[];
  mbti: string | null;
  strengths: string[]; // 資質 id・配列順＝1〜5位
  blocks: ProfileBlock[];
};

function draftFromProfile(p: ProfileRow | undefined): ProfileDraft {
  return {
    nickname: p?.nickname ?? "",
    careerRows: (p?.career_rows ?? []).map((r) => ({ ...r })),
    specialties: [...(p?.specialties ?? [])],
    hobbyTags: [...(p?.hobby_tags ?? [])],
    mbti: normalizeMbti(p?.mbti ?? null),
    strengths: normalizeStrengthIds(p?.strengths ?? []),
    blocks: normalizeBlocks(p?.blocks ?? []),
  };
}

export function EmployeeDetailPage({ num }: { num: string }) {
  const navigate = useUiStore((s) => s.navigate);
  const setToast = useOrgStore((s) => s.setToast);
  const currentRole = useAuthStore((s) => s.currentUser?.role);

  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);

  const profiles = useProfilesStore((s) => s.profilesByNumber);
  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const profilesError = useProfilesStore((s) => s.error);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const saveProfile = useProfilesStore((s) => s.saveProfile);
  const uploadPhoto = useProfilesStore((s) => s.uploadPhoto);
  const uploadBlockImage = useProfilesStore((s) => s.uploadBlockImage);
  const removePhoto = useProfilesStore((s) => s.removePhoto);
  const setAvatar = useProfilesStore((s) => s.setAvatar);
  const ensurePhotoUrls = useProfilesStore((s) => s.ensurePhotoUrls);
  const photoUrls = useProfilesStore((s) => s.photoUrls);

  const emp = employees.find((e) => e.employee_number === num);
  const profile = profiles[num];

  const canEdit = canEditProfileOf(num);
  const payrollAllowed = canAccessPayroll(currentRole);

  // ── データロード ──
  const reload = useCallback(() => {
    if (employees.length === 0) refreshEmployees();
    refreshProfiles({ silent: true });
  }, [employees.length, refreshEmployees, refreshProfiles]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [reload]);

  // ── グレード（payroll 閲覧権限者のみ） ──
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
    const found = best;
    const grade = payrollGrades.find((g) => g.code === found.grade_code);
    return { code: found.grade_code, label: grade?.label ?? null };
  }, [payrollAllowed, payrollRecords, payrollPeriods, payrollGrades, num]);

  // ── 自動異動歴（SHO-SAN経歴の初期値／careerRows 空のときのフォールバック表示） ──
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

  const autoHistory = useMemo<HistoryEntry[]>(() => {
    if (!confirmedVersions) return [];
    const byPeriod = new Map<string, HistoryEntry>();
    for (const v of confirmedVersions) {
      if (!v.confirmed_period || !v.snapshot?.nodes) continue;
      const path = pathForEmployee(v.snapshot.nodes, num);
      if (!path) continue;
      byPeriod.set(v.confirmed_period, { period: v.confirmed_period, path });
    }
    return [...byPeriod.values()].sort((a, b) => a.period.localeCompare(b.period));
  }, [confirmedVersions, num]);

  // ── 写真＋ブロック画像の signed URL ──
  useEffect(() => {
    const paths = (profile?.photos ?? []).map((p) => p.path);
    if (profile?.avatar_path) paths.push(profile.avatar_path);
    paths.push(...collectBlockImagePaths(normalizeBlocks(profile?.blocks ?? [])));
    if (paths.length > 0) ensurePhotoUrls(paths);
  }, [profile, ensurePhotoUrls]);

  const avatarPath = avatarPathOf(profile);
  const avatarUrl = avatarPath ? photoUrls[avatarPath] : undefined;

  // ── 統一編集フォーム ──
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  function startEdit() {
    const d = draftFromProfile(profile);
    // careerRows が空なら自動異動歴を初期値として取り込む（要件 7-1）
    if (d.careerRows.length === 0 && autoHistory.length > 0) {
      d.careerRows = autoHistory.map((h) => ({
        id: newId(),
        period_from: h.period,
        period_to: null,
        body: h.path,
      }));
    }
    setDraft(d);
    setEditing(true);
  }

  async function commitEdit() {
    setSaving(true);
    const res = await saveProfile({
      employee_number: num,
      nickname: draft.nickname.trim() || null,
      career_rows: draft.careerRows
        .filter((r) => r.body.trim() || r.period_from.trim())
        .map((r) => ({
          id: r.id,
          period_from: r.period_from.trim(),
          period_to: r.period_to?.trim() || null,
          body: r.body.trim(),
        })),
      specialties: dedupeTags(draft.specialties),
      hobby_tags: dedupeTags(draft.hobbyTags),
      mbti: draft.mbti,
      strengths: draft.strengths.slice(0, 5),
      blocks: pruneBlocks(draft.blocks),
    });
    setSaving(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
      return;
    }
    setEditing(false);
    setToast({ kind: "info", message: "プロフィールを保存しました" });
  }

  async function handleBlockImageUpload(blockId: string, file: File) {
    setUploading(true);
    const res = await uploadBlockImage(num, file);
    setUploading(false);
    if (!res.ok || !res.path) {
      setToast({ kind: "error", message: res.reason ?? "画像アップロードに失敗しました" });
      return;
    }
    const path = res.path;
    setDraft((d) => ({
      ...d,
      blocks: d.blocks.map((b) =>
        b.id === blockId && b.type === "image"
          ? { ...b, images: [...b.images, { path }] }
          : b,
      ),
    }));
  }

  // ── 写真ギャラリー（即時保存・ドラフト外） ──
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

  const displayName = emp ? employeeName(emp) : num;
  const initial = displayName.trim()[0]?.toUpperCase() ?? "?";
  const viewBlocks = useMemo(() => normalizeBlocks(profile?.blocks ?? []), [profile]);
  const viewMbti = normalizeMbti(profile?.mbti ?? null);
  const viewStrengths = normalizeStrengthIds(profile?.strengths ?? []);

  return (
    <main className="page empdetail">
      <div className="page__header">
        <div>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => navigate({ name: "employees" })}
          >
            ‹ メンバーへ戻る
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
      </section>

      {editing ? (
        <EditForm
          draft={draft}
          setDraft={setDraft}
          uploading={uploading}
          onBlockImageUpload={handleBlockImageUpload}
          photoUrls={photoUrls}
        />
      ) : (
        <>
          {/* ── SHO-SAN経歴 ─────────────────────────────────────── */}
          <section className="empdetail__section">
            <h2 className="empdetail__sectionTitle">SHO-SAN経歴</h2>
            {(profile?.career_rows ?? []).length > 0 ? (
              <ol className="empdetail__career">
                {(profile?.career_rows ?? []).map((r) => (
                  <li key={r.id} className="empdetail__careerRow">
                    <span className="empdetail__careerPeriod">
                      {r.period_from || "—"}
                      {" 〜 "}
                      {r.period_to || "現在"}
                    </span>
                    <span className="empdetail__careerBody">{r.body}</span>
                  </li>
                ))}
              </ol>
            ) : confirmedVersions === null ? (
              <p className="empdetail__empty">読み込み中…</p>
            ) : autoHistory.length > 0 ? (
              <>
                <ol className="empdetail__career empdetail__career--auto">
                  {autoHistory.map((h) => (
                    <li key={h.period} className="empdetail__careerRow">
                      <span className="empdetail__careerPeriod">{h.period}</span>
                      <span className="empdetail__careerBody">{h.path}</span>
                    </li>
                  ))}
                </ol>
                <p className="empdetail__hint">
                  ※ 確定版の組織図から自動生成した配属履歴です。「プロフィールを編集」で経歴として取り込み・編集できます。
                </p>
              </>
            ) : (
              <p className="empdetail__empty">経歴はまだ登録されていません。</p>
            )}
          </section>

          {/* ── 得意領域・趣味 ───────────────────────────────────── */}
          <section className="empdetail__section">
            <h2 className="empdetail__sectionTitle">プロフィール</h2>
            <dl className="empdetail__fields">
              <div className="empdetail__field">
                <dt>得意領域</dt>
                <dd>
                  <TagList tags={profile?.specialties ?? []} tone="specialty" />
                </dd>
              </div>
              <div className="empdetail__field">
                <dt>趣味</dt>
                <dd>
                  <TagList tags={profile?.hobby_tags ?? []} tone="hobby" />
                </dd>
              </div>
              <div className="empdetail__field">
                <dt>MBTI</dt>
                <dd>{viewMbti ? <MbtiBadge code={viewMbti} /> : <Empty />}</dd>
              </div>
              <div className="empdetail__field">
                <dt>ストレングスファインダー</dt>
                <dd>
                  {viewStrengths.length > 0 ? (
                    <StrengthList ids={viewStrengths} />
                  ) : (
                    <Empty />
                  )}
                </dd>
              </div>
            </dl>
          </section>

          {/* ── 自由プロフィール（ブロック） ─────────────────────── */}
          {viewBlocks.length > 0 && (
            <section className="empdetail__section">
              <h2 className="empdetail__sectionTitle">自己紹介</h2>
              <BlockView blocks={viewBlocks} photoUrls={photoUrls} />
            </section>
          )}
        </>
      )}

      {/* ── 写真ギャラリー（編集モードと独立・非回帰） ───────────── */}
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
      {/* 人事機密層は P3 で UI 撤去（データ・RLS はDBに温存）。 */}
    </main>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  表示用サブコンポーネント
// ═══════════════════════════════════════════════════════════════════

function Empty() {
  return <span className="empdetail__empty">未設定</span>;
}

function TagList({ tags, tone }: { tags: string[]; tone: "specialty" | "hobby" }) {
  if (tags.length === 0) return <Empty />;
  return (
    <div className="empdetail__tags">
      {tags.map((t, i) => (
        <span key={`${t}_${i}`} className={`tag tag--${tone}`}>
          {t}
        </span>
      ))}
    </div>
  );
}

function MbtiBadge({ code }: { code: string }) {
  const t = MBTI_BY_CODE[code];
  if (!t) return <span className="emppage__chip">{code}</span>;
  const color = MBTI_GROUP_COLOR[t.group];
  return (
    <span className="mbtiBadge" style={{ borderColor: color }} title={t.blurb}>
      <img className="mbtiBadge__avatar" src={mbtiAvatarDataUri(code)} alt="" width={28} height={28} />
      <span className="mbtiBadge__text">
        <span className="mbtiBadge__code" style={{ color }}>
          {code}
        </span>
        <span className="mbtiBadge__nick">{t.nickname}</span>
      </span>
      <a
        className="mbtiBadge__link"
        href={mbtiExternalUrl(code)}
        target="_blank"
        rel="noopener noreferrer"
        title="16personalities で詳しく見る"
        onClick={(e) => e.stopPropagation()}
      >
        ↗
      </a>
    </span>
  );
}

function StrengthList({ ids }: { ids: string[] }) {
  return (
    <div className="empdetail__strengths">
      {ids.map((id, i) => {
        const q = STRENGTH_BY_ID[id];
        if (!q) return null;
        const color = STRENGTH_DOMAIN_COLOR[q.domain];
        return (
          <span
            key={id}
            className="strengthBadge"
            style={{ background: color }}
            title={`${STRENGTH_DOMAIN_LABEL[q.domain]}：${q.description}`}
          >
            <span className="strengthBadge__rank">{i + 1}</span>
            <span className="strengthBadge__name">{q.name_ja}</span>
            <span className="strengthBadge__q" aria-hidden>
              ?
            </span>
          </span>
        );
      })}
    </div>
  );
}

/** text ブロックの本文を URL 自動リンク化して描画。 */
function renderTextWithLinks(text: string) {
  const parts = text.split(URL_REGEX);
  return parts.map((part, i) =>
    URL_REGEX.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer">
        {part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

function BlockView({
  blocks,
  photoUrls,
}: {
  blocks: ProfileBlock[];
  photoUrls: Record<string, string>;
}) {
  return (
    <div className="blockview">
      {blocks.map((b) => {
        switch (b.type) {
          case "heading":
            return (
              <h3 key={b.id} className="blockview__heading">
                {b.text}
              </h3>
            );
          case "text":
            return (
              <p key={b.id} className="blockview__text">
                {renderTextWithLinks(b.text)}
              </p>
            );
          case "image":
            return (
              <div key={b.id} className="blockview__images">
                {b.images.map((im, i) => (
                  <figure key={`${im.path}_${i}`} className="blockview__image">
                    {photoUrls[im.path] ? (
                      <img src={photoUrls[im.path]} alt={im.caption ?? ""} loading="lazy" />
                    ) : (
                      <div className="empdetail__photoLoading">…</div>
                    )}
                    {im.caption && <figcaption>{im.caption}</figcaption>}
                  </figure>
                ))}
              </div>
            );
          case "link":
            return (
              <a
                key={b.id}
                className="blockview__link"
                href={b.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="blockview__linkTitle">{b.title || b.url}</span>
                {b.description && (
                  <span className="blockview__linkDesc">{b.description}</span>
                )}
                <span className="blockview__linkUrl">{b.url}</span>
              </a>
            );
        }
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  編集フォーム
// ═══════════════════════════════════════════════════════════════════

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 30);
}

function EditForm({
  draft,
  setDraft,
  uploading,
  onBlockImageUpload,
  photoUrls,
}: {
  draft: ProfileDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProfileDraft>>;
  uploading: boolean;
  onBlockImageUpload: (blockId: string, file: File) => void;
  photoUrls: Record<string, string>;
}) {
  return (
    <>
      {/* あだ名 */}
      <section className="empdetail__section">
        <h2 className="empdetail__sectionTitle">基本</h2>
        <label className="empdetail__formRow">
          <span className="field__label">あだ名</span>
          <input
            className="field__input"
            value={draft.nickname}
            onChange={(e) => setDraft((d) => ({ ...d, nickname: e.target.value }))}
            placeholder="例: ゆーほー"
          />
        </label>
      </section>

      {/* SHO-SAN経歴 */}
      <section className="empdetail__section">
        <h2 className="empdetail__sectionTitle">SHO-SAN経歴</h2>
        <CareerEditor rows={draft.careerRows} setDraft={setDraft} />
      </section>

      {/* 得意領域・趣味・MBTI・ストレングス */}
      <section className="empdetail__section">
        <h2 className="empdetail__sectionTitle">プロフィール</h2>
        <div className="empdetail__formRow">
          <span className="field__label">得意領域（タグ・複数可）</span>
          <TagEditor
            tags={draft.specialties}
            tone="specialty"
            placeholder="例: BtoBマーケ戦略"
            onChange={(tags) => setDraft((d) => ({ ...d, specialties: tags }))}
          />
        </div>
        <div className="empdetail__formRow">
          <span className="field__label">趣味（タグ・複数可）</span>
          <TagEditor
            tags={draft.hobbyTags}
            tone="hobby"
            placeholder="例: サウナ"
            onChange={(tags) => setDraft((d) => ({ ...d, hobbyTags: tags }))}
          />
        </div>
        <div className="empdetail__formRow">
          <span className="field__label">MBTI</span>
          <MbtiPicker
            value={draft.mbti}
            onChange={(code) => setDraft((d) => ({ ...d, mbti: code }))}
          />
        </div>
        <div className="empdetail__formRow">
          <span className="field__label">ストレングスファインダー（34資質から5つ・順位付き）</span>
          <StrengthPicker
            ids={draft.strengths}
            onChange={(ids) => setDraft((d) => ({ ...d, strengths: ids }))}
          />
        </div>
      </section>

      {/* 自由プロフィール（ブロックエディタ） */}
      <section className="empdetail__section">
        <h2 className="empdetail__sectionTitle">自己紹介（自由ブロック）</h2>
        <BlockEditor
          blocks={draft.blocks}
          setDraft={setDraft}
          uploading={uploading}
          onImageUpload={onBlockImageUpload}
          photoUrls={photoUrls}
        />
      </section>
    </>
  );
}

// ── SHO-SAN経歴エディタ ────────────────────────────────────────────
function CareerEditor({
  rows,
  setDraft,
}: {
  rows: CareerRow[];
  setDraft: React.Dispatch<React.SetStateAction<ProfileDraft>>;
}) {
  function update(id: string, patch: Partial<CareerRow>) {
    setDraft((d) => ({
      ...d,
      careerRows: d.careerRows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  }
  function move(idx: number, dir: -1 | 1) {
    setDraft((d) => {
      const arr = [...d.careerRows];
      const to = idx + dir;
      if (to < 0 || to >= arr.length) return d;
      [arr[idx], arr[to]] = [arr[to], arr[idx]];
      return { ...d, careerRows: arr };
    });
  }
  return (
    <div className="careerEditor">
      {rows.map((r, idx) => (
        <div key={r.id} className="careerEditor__row">
          <input
            className="field__input field__input--xs careerEditor__period"
            type="month"
            value={r.period_from}
            onChange={(e) => update(r.id, { period_from: e.target.value })}
            title="開始（YYYY-MM）"
          />
          <span className="careerEditor__tilde">〜</span>
          <input
            className="field__input field__input--xs careerEditor__period"
            type="month"
            value={r.period_to ?? ""}
            onChange={(e) => update(r.id, { period_to: e.target.value || null })}
            title="終了（空欄＝現在）"
          />
          <input
            className="field__input field__input--xs careerEditor__body"
            placeholder="配属・役割（例: マーケDIV / 広告TM リーダー）"
            value={r.body}
            onChange={(e) => update(r.id, { body: e.target.value })}
          />
          <button className="btn btn--ghost btn--xs" onClick={() => move(idx, -1)} disabled={idx === 0} title="上へ">
            ↑
          </button>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => move(idx, 1)}
            disabled={idx === rows.length - 1}
            title="下へ"
          >
            ↓
          </button>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() =>
              setDraft((d) => ({ ...d, careerRows: d.careerRows.filter((x) => x.id !== r.id) }))
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
            careerRows: [
              ...d.careerRows,
              { id: newId(), period_from: "", period_to: null, body: "" },
            ],
          }))
        }
      >
        ＋経歴を追加
      </button>
    </div>
  );
}

// ── タグエディタ ──────────────────────────────────────────────────
function TagEditor({
  tags,
  tone,
  placeholder,
  onChange,
}: {
  tags: string[];
  tone: "specialty" | "hobby";
  placeholder?: string;
  onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState("");
  function add() {
    const t = input.trim();
    if (!t) return;
    if (!tags.includes(t)) onChange([...tags, t]);
    setInput("");
  }
  return (
    <div className="tagEditor">
      <div className="tagEditor__chips">
        {tags.map((t, i) => (
          <span key={`${t}_${i}`} className={`tag tag--${tone} tag--removable`}>
            {t}
            <button
              className="tag__remove"
              onClick={() => onChange(tags.filter((_, idx) => idx !== i))}
              aria-label={`${t} を削除`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="tagEditor__input">
        <input
          className="field__input field__input--xs"
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn btn--ghost btn--xs" onClick={add} disabled={!input.trim()}>
          追加
        </button>
      </div>
    </div>
  );
}

// ── MBTI ピッカー（4グループ×4タイプのカードグリッド） ─────────────
function MbtiPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (code: string | null) => void;
}) {
  return (
    <div className="mbtiPicker">
      <div className="mbtiPicker__grid">
        {MBTI_GROUP_ORDER.map((group) => (
          <div key={group} className="mbtiPicker__col">
            <div className="mbtiPicker__colHead" style={{ color: MBTI_GROUP_COLOR[group] }}>
              {MBTI_GROUP_LABEL[group]}
            </div>
            {MBTI_TYPES.filter((t) => t.group === group).map((t) => {
              const selected = value === t.code;
              return (
                <button
                  key={t.code}
                  className={`mbtiCard ${selected ? "is-selected" : ""}`}
                  style={selected ? { borderColor: MBTI_GROUP_COLOR[group] } : undefined}
                  onClick={() => onChange(selected ? null : t.code)}
                  title={t.blurb}
                >
                  <img src={mbtiAvatarDataUri(t.code)} alt="" width={32} height={32} />
                  <span className="mbtiCard__code" style={{ color: MBTI_GROUP_COLOR[group] }}>
                    {t.code}
                  </span>
                  <span className="mbtiCard__nick">{t.nickname}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {value && (
        <div className="mbtiPicker__selected">
          選択中：<strong>{value}</strong>（{MBTI_BY_CODE[value]?.nickname}）
          <button className="btn btn--ghost btn--xs" onClick={() => onChange(null)}>
            クリア
          </button>
        </div>
      )}
    </div>
  );
}

// ── ストレングス ピッカー（34資質から5つ順位選択） ─────────────────
function StrengthPicker({
  ids,
  onChange,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
}) {
  const full = ids.length >= 5;
  function move(idx: number, dir: -1 | 1) {
    const arr = [...ids];
    const to = idx + dir;
    if (to < 0 || to >= arr.length) return;
    [arr[idx], arr[to]] = [arr[to], arr[idx]];
    onChange(arr);
  }
  const byDomain = useMemo(() => {
    const groups: Record<StrengthDomain, typeof STRENGTHS> = {
      executing: [],
      influencing: [],
      relationship: [],
      strategic: [],
    };
    for (const q of STRENGTHS) groups[q.domain].push(q);
    return groups;
  }, []);
  return (
    <div className="strengthPicker">
      <ol className="strengthPicker__ranked">
        {ids.map((id, i) => {
          const q = STRENGTH_BY_ID[id];
          if (!q) return null;
          const color = STRENGTH_DOMAIN_COLOR[q.domain];
          return (
            <li key={id} className="strengthPicker__rankRow">
              <span className="strengthBadge" style={{ background: color }} title={q.description}>
                <span className="strengthBadge__rank">{i + 1}</span>
                <span className="strengthBadge__name">{q.name_ja}</span>
              </span>
              <button className="btn btn--ghost btn--xs" onClick={() => move(i, -1)} disabled={i === 0} title="順位を上げる">
                ↑
              </button>
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => move(i, 1)}
                disabled={i === ids.length - 1}
                title="順位を下げる"
              >
                ↓
              </button>
              <button
                className="btn btn--ghost btn--xs"
                onClick={() => onChange(ids.filter((x) => x !== id))}
                title="外す"
              >
                ✕
              </button>
            </li>
          );
        })}
        {ids.length === 0 && (
          <li className="empdetail__empty">下の一覧から5つまで選択してください。</li>
        )}
      </ol>
      <select
        className="field__input field__input--xs"
        value=""
        disabled={full}
        onChange={(e) => {
          const id = e.target.value;
          if (id && !ids.includes(id) && ids.length < 5) onChange([...ids, id]);
        }}
      >
        <option value="">{full ? "5つ選択済み（外すと追加できます）" : "＋資質を追加…"}</option>
        {(Object.keys(byDomain) as StrengthDomain[]).map((dom) => (
          <optgroup key={dom} label={STRENGTH_DOMAIN_LABEL[dom]}>
            {byDomain[dom]
              .filter((q) => !ids.includes(q.id))
              .map((q) => (
                <option key={q.id} value={q.id}>
                  {q.name_ja}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
      <p className="empdetail__hint">
        各バッジは領域カラー（実行力=紫／影響力=オレンジ／人間関係構築力=青／戦略的思考力=緑）。ホバーで説明を表示します。
      </p>
    </div>
  );
}

// ── ブロックエディタ ──────────────────────────────────────────────
function BlockEditor({
  blocks,
  setDraft,
  uploading,
  onImageUpload,
  photoUrls,
}: {
  blocks: ProfileBlock[];
  setDraft: React.Dispatch<React.SetStateAction<ProfileDraft>>;
  uploading: boolean;
  onImageUpload: (blockId: string, file: File) => void;
  photoUrls: Record<string, string>;
}) {
  function patch(id: string, fn: (b: ProfileBlock) => ProfileBlock) {
    setDraft((d) => ({ ...d, blocks: d.blocks.map((b) => (b.id === id ? fn(b) : b)) }));
  }
  function move(idx: number, dir: -1 | 1) {
    setDraft((d) => {
      const arr = [...d.blocks];
      const to = idx + dir;
      if (to < 0 || to >= arr.length) return d;
      [arr[idx], arr[to]] = [arr[to], arr[idx]];
      return { ...d, blocks: arr };
    });
  }
  function addBlock(type: BlockType) {
    setDraft((d) => ({ ...d, blocks: [...d.blocks, emptyBlock(type)] }));
  }
  return (
    <div className="blockEditor">
      {blocks.map((b, idx) => (
        <div key={b.id} className="blockEditor__block">
          <div className="blockEditor__toolbar">
            <span className="blockEditor__type">{BLOCK_TYPE_LABEL[b.type]}</span>
            <span className="blockEditor__spacer" />
            <button className="btn btn--ghost btn--xs" onClick={() => move(idx, -1)} disabled={idx === 0} title="上へ">
              ↑
            </button>
            <button
              className="btn btn--ghost btn--xs"
              onClick={() => move(idx, 1)}
              disabled={idx === blocks.length - 1}
              title="下へ"
            >
              ↓
            </button>
            <button
              className="btn btn--ghost btn--xs"
              onClick={() =>
                setDraft((d) => ({ ...d, blocks: d.blocks.filter((x) => x.id !== b.id) }))
              }
              title="削除"
            >
              ✕
            </button>
          </div>
          {b.type === "heading" && (
            <input
              className="field__input blockEditor__heading"
              placeholder="見出し"
              value={b.text}
              onChange={(e) => patch(b.id, (blk) => ({ ...(blk as typeof b), text: e.target.value }))}
            />
          )}
          {b.type === "text" && (
            <textarea
              className="field__input"
              rows={4}
              placeholder="テキスト（改行可・URLは自動でリンクになります）"
              value={b.text}
              onChange={(e) => patch(b.id, (blk) => ({ ...(blk as typeof b), text: e.target.value }))}
            />
          )}
          {b.type === "image" && (
            <div className="blockEditor__images">
              {b.images.map((im, i) => (
                <figure key={`${im.path}_${i}`} className="blockEditor__imageItem">
                  {photoUrls[im.path] ? (
                    <img src={photoUrls[im.path]} alt={im.caption ?? ""} />
                  ) : (
                    <div className="empdetail__photoLoading">…</div>
                  )}
                  <input
                    className="field__input field__input--xs"
                    placeholder="キャプション（任意）"
                    value={im.caption ?? ""}
                    onChange={(e) =>
                      patch(b.id, (blk) => {
                        const img = blk as typeof b;
                        return {
                          ...img,
                          images: img.images.map((x, xi) =>
                            xi === i ? { ...x, caption: e.target.value || undefined } : x,
                          ),
                        };
                      })
                    }
                  />
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() =>
                      patch(b.id, (blk) => {
                        const img = blk as typeof b;
                        return { ...img, images: img.images.filter((_, xi) => xi !== i) };
                      })
                    }
                  >
                    画像を削除
                  </button>
                </figure>
              ))}
              <label className="btn btn--ghost btn--xs" style={{ cursor: "pointer" }}>
                {uploading ? "アップロード中…" : "＋画像を追加"}
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  disabled={uploading}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onImageUpload(b.id, f);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
          )}
          {b.type === "link" && (
            <div className="blockEditor__link">
              <input
                className="field__input field__input--xs"
                placeholder="URL（https://…）"
                value={b.url}
                onChange={(e) => patch(b.id, (blk) => ({ ...(blk as typeof b), url: e.target.value }))}
              />
              <input
                className="field__input field__input--xs"
                placeholder="タイトル（任意）"
                value={b.title ?? ""}
                onChange={(e) =>
                  patch(b.id, (blk) => ({ ...(blk as typeof b), title: e.target.value || undefined }))
                }
              />
              <input
                className="field__input field__input--xs"
                placeholder="説明（任意）"
                value={b.description ?? ""}
                onChange={(e) =>
                  patch(b.id, (blk) => ({
                    ...(blk as typeof b),
                    description: e.target.value || undefined,
                  }))
                }
              />
            </div>
          )}
        </div>
      ))}
      <div className="blockEditor__add">
        <span className="field__label">ブロックを追加：</span>
        {(Object.keys(BLOCK_TYPE_LABEL) as BlockType[]).map((type) => (
          <button key={type} className="btn btn--ghost btn--xs" onClick={() => addBlock(type)}>
            ＋{BLOCK_TYPE_LABEL[type]}
          </button>
        ))}
      </div>
    </div>
  );
}
