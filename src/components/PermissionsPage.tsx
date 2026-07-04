import { useEffect, useMemo, useState } from "react";
import { useProfilesStore } from "../store/useProfilesStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { useAuthStore } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import { canManagePermissions } from "../lib/supabase";
import { MODULE_LABEL, ACTION_LABEL } from "../lib/profile";
import type { PositionLevelRow } from "../lib/profile";

type PermTab = "levels" | "modules" | "grants";

const TAB_LABEL: Record<PermTab, string> = {
  levels: "役職レベル",
  modules: "モジュール権限",
  grants: "個別付与",
};

/** レベルのプルダウン候補。役職レベル辞書に存在する値とマージして使う。 */
const BASE_LEVELS = [0, 10, 20, 40, 60, 90];

function moduleActionLabel(module: string, action: string): string {
  return `${MODULE_LABEL[module] ?? module}：${ACTION_LABEL[action] ?? action}`;
}

/**
 * 権限管理画面（route: #/permissions・master / privileged_admin のみ）。
 *   タブ1: 役職レベル — position_levels のインライン編集＋未設定役職の警告
 *   タブ2: モジュール権限 — module_permissions の min_level をプルダウン編集
 *   タブ3: 個別付与 — permission_grants の追加/削除
 * 真の強制は RLS（書込みは master/admin/privileged_admin のみ通る）。
 */
export function PermissionsPage() {
  const role = useAuthStore((s) => s.currentUser?.role);
  const setToast = useOrgStore((s) => s.setToast);

  const positionLevels = useProfilesStore((s) => s.positionLevels);
  const modulePermissions = useProfilesStore((s) => s.modulePermissions);
  const permissionGrants = useProfilesStore((s) => s.permissionGrants);
  const loaded = useProfilesStore((s) => s.loaded);
  const loading = useProfilesStore((s) => s.loading);
  const error = useProfilesStore((s) => s.error);
  const refresh = useProfilesStore((s) => s.refresh);
  const upsertPositionLevel = useProfilesStore((s) => s.upsertPositionLevel);
  const setModulePermissionLevel = useProfilesStore((s) => s.setModulePermissionLevel);
  const addGrant = useProfilesStore((s) => s.addGrant);
  const removeGrant = useProfilesStore((s) => s.removeGrant);

  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);

  const [tab, setTab] = useState<PermTab>("levels");

  useEffect(() => {
    refresh();
    if (employees.length === 0) refreshEmployees();
    // 表示時 fetch のみ（低頻度データのためポーリングなし）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // employees に存在するが辞書に無い役職 =「未設定役職」
  const unregisteredTitles = useMemo(() => {
    const known = new Set(positionLevels.map((l) => l.position_title));
    const titles = new Set<string>();
    for (const e of employees) {
      const t = e.position_title?.trim();
      if (t && !known.has(t)) titles.add(t);
    }
    return [...titles].sort((a, b) => a.localeCompare(b, "ja"));
  }, [employees, positionLevels]);

  const levelOptions = useMemo(() => {
    const set = new Set<number>(BASE_LEVELS);
    for (const l of positionLevels) set.add(l.level);
    for (const m of modulePermissions) set.add(m.min_level);
    return [...set].sort((a, b) => a - b);
  }, [positionLevels, modulePermissions]);

  if (!canManagePermissions(role)) {
    // App.tsx 側でリダイレクトされるが、描画の一瞬も出さない
    return (
      <main className="page">
        <p className="versions__error">このページを表示する権限がありません。</p>
      </main>
    );
  }

  return (
    <main className="page permpage">
      <div className="page__header">
        <div>
          <h1 className="page__title">権限管理</h1>
          <p className="page__subtitle">
            役職→レベルの正規化辞書と、モジュール×操作の必要レベル、個別付与を管理します。
            従業員の実権限＝「役職レベル到達 OR 個別付与 OR master/特権管理者」。
          </p>
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      <div className="payroll-tabs" role="tablist">
        {(["levels", "modules", "grants"] as PermTab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`payroll-tab ${tab === t ? "is-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      {loading && !loaded && <p className="empdetail__empty">読み込み中…</p>}

      {tab === "levels" && (
        <LevelsTab
          rows={positionLevels}
          unregisteredTitles={unregisteredTitles}
          onSave={async (row) => {
            const res = await upsertPositionLevel(row);
            setToast(
              res.ok
                ? { kind: "info", message: `役職「${row.position_title}」を保存しました` }
                : { kind: "error", message: res.reason ?? "保存に失敗しました" },
            );
            return res.ok;
          }}
        />
      )}

      {tab === "modules" && (
        <div className="emppage__tableWrap">
          <table className="empmgr__table emppage__table">
            <thead>
              <tr>
                <th>モジュール</th>
                <th>操作</th>
                <th style={{ width: 180 }}>必要レベル</th>
              </tr>
            </thead>
            <tbody>
              {modulePermissions.length === 0 && (
                <tr>
                  <td colSpan={3} className="usermgr__empty">
                    モジュール権限が未定義です（migration 0015 を適用してください）。
                  </td>
                </tr>
              )}
              {[...modulePermissions]
                .sort((a, b) => a.module.localeCompare(b.module) || a.action.localeCompare(b.action))
                .map((m) => (
                  <tr key={`${m.module}:${m.action}`}>
                    <td>{MODULE_LABEL[m.module] ?? m.module}</td>
                    <td>
                      {ACTION_LABEL[m.action] ?? m.action}
                      <span className="permpage__code"><code>{m.module}.{m.action}</code></span>
                    </td>
                    <td>
                      <select
                        className="field__input field__input--xs"
                        value={m.min_level}
                        onChange={async (e) => {
                          const lv = Number(e.target.value);
                          const res = await setModulePermissionLevel(m.module, m.action, lv);
                          if (!res.ok) {
                            setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
                          }
                        }}
                      >
                        {levelOptions.map((lv) => (
                          <option key={lv} value={lv}>レベル {lv} 以上</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "grants" && (
        <GrantsTab
          grants={permissionGrants}
          moduleActions={modulePermissions.map((m) => ({ module: m.module, action: m.action }))}
          onAdd={async (email, module, action) => {
            const res = await addGrant(email, module, action);
            setToast(
              res.ok
                ? { kind: "info", message: `${email} に ${moduleActionLabel(module, action)} を付与しました` }
                : { kind: "error", message: res.reason ?? "付与に失敗しました" },
            );
            return res.ok;
          }}
          onRemove={async (email, module, action) => {
            const res = await removeGrant(email, module, action);
            if (!res.ok) {
              setToast({ kind: "error", message: res.reason ?? "削除に失敗しました" });
            }
          }}
        />
      )}
    </main>
  );
}

// ── タブ1: 役職レベル ─────────────────────────────────────────────────
function LevelsTab({
  rows,
  unregisteredTitles,
  onSave,
}: {
  rows: PositionLevelRow[];
  unregisteredTitles: string[];
  onSave: (row: Partial<PositionLevelRow> & { position_title: string }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [levelDraft, setLevelDraft] = useState<number>(0);
  const [labelDraft, setLabelDraft] = useState<string>("");

  function startEdit(row: PositionLevelRow) {
    setEditing(row.position_title);
    setLevelDraft(row.level);
    setLabelDraft(row.label ?? "");
  }

  async function commit(title: string) {
    const ok = await onSave({
      position_title: title,
      level: levelDraft,
      label: labelDraft.trim() || null,
    });
    if (ok) setEditing(null);
  }

  return (
    <>
      {unregisteredTitles.length > 0 && (
        <div className="permpage__warn">
          ⚠ 従業員マスターに存在するがレベル未設定の役職が {unregisteredTitles.length} 件あります
          （レベル 0＝一般扱い）：
          <div className="permpage__warnList">
            {unregisteredTitles.map((t) => (
              <button
                key={t}
                className="btn btn--ghost btn--xs"
                onClick={() => onSave({ position_title: t, level: 0 })}
                title="辞書に追加（レベル0で登録後に編集）"
              >
                ＋「{t}」を追加
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th>役職名（employees の生値）</th>
              <th style={{ width: 120 }}>レベル</th>
              <th>表示ラベル</th>
              <th style={{ width: 120 }} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="usermgr__empty">
                  役職レベルが未登録です（migration 0015 を適用してください）。
                </td>
              </tr>
            )}
            {rows.map((row) => {
              if (editing === row.position_title) {
                return (
                  <tr key={row.position_title} className="empmgr__editRow">
                    <td>{row.position_title}</td>
                    <td>
                      <input
                        className="field__input field__input--xs"
                        type="number"
                        min={0}
                        max={100}
                        value={levelDraft}
                        onChange={(e) => setLevelDraft(Number(e.target.value))}
                      />
                    </td>
                    <td>
                      <input
                        className="field__input field__input--xs"
                        placeholder="例: 役員 / DM / TM"
                        value={labelDraft}
                        onChange={(e) => setLabelDraft(e.target.value)}
                      />
                    </td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button
                        className="btn btn--primary btn--xs"
                        onClick={() => commit(row.position_title)}
                      >
                        保存
                      </button>{" "}
                      <button className="btn btn--ghost btn--xs" onClick={() => setEditing(null)}>
                        取消
                      </button>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={row.position_title}>
                  <td>{row.position_title}</td>
                  <td>
                    <span className={`permpage__level permpage__level--${row.level >= 60 ? "high" : row.level > 0 ? "mid" : "zero"}`}>
                      {row.level}
                    </span>
                  </td>
                  <td>{row.label ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>
                    <button className="btn btn--ghost btn--xs" onClick={() => startEdit(row)}>
                      編集
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="empdetail__hint">
        ※ 目安: 役員=90 ／ DM・CDM=60 ／ TM・CTM=40 ／ TL・CTL=20 ／ UL=10 ／ 一般=0
      </p>
    </>
  );
}

// ── タブ3: 個別付与 ───────────────────────────────────────────────────
function GrantsTab({
  grants,
  moduleActions,
  onAdd,
  onRemove,
}: {
  grants: { email: string; module: string; action: string; granted_by_email: string | null; created_at: string }[];
  moduleActions: { module: string; action: string }[];
  onAdd: (email: string, module: string, action: string) => Promise<boolean>;
  onRemove: (email: string, module: string, action: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  // 選択値は state を直接初期化せず「未選択なら先頭候補」を導出する —
  // options ロード前にマウントされると空のまま固定される問題への対策。
  const [pair, setPair] = useState<string>("");
  const effectivePair =
    pair ||
    (moduleActions[0] ? `${moduleActions[0].module}:${moduleActions[0].action}` : "");
  const [adding, setAdding] = useState(false);

  async function handleAdd() {
    const [module, action] = effectivePair.split(":");
    if (!email.trim() || !module || !action) return;
    setAdding(true);
    const ok = await onAdd(email, module, action);
    setAdding(false);
    if (ok) setEmail("");
  }

  return (
    <>
      <div className="permpage__grantForm">
        <input
          className="field__input"
          type="email"
          placeholder="メールアドレス（例: taro@sho-san.co.jp）"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ flex: "1 1 240px" }}
        />
        <select
          className="field__input"
          value={effectivePair}
          onChange={(e) => setPair(e.target.value)}
        >
          {moduleActions.map((ma) => (
            <option key={`${ma.module}:${ma.action}`} value={`${ma.module}:${ma.action}`}>
              {moduleActionLabel(ma.module, ma.action)}
            </option>
          ))}
        </select>
        <button
          className="btn btn--primary"
          onClick={handleAdd}
          disabled={adding || !email.trim() || !effectivePair}
        >
          {adding ? "付与中…" : "＋付与"}
        </button>
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th>メールアドレス</th>
              <th>権限</th>
              <th>付与者</th>
              <th style={{ width: 140 }}>付与日</th>
              <th style={{ width: 80 }} />
            </tr>
          </thead>
          <tbody>
            {grants.length === 0 && (
              <tr>
                <td colSpan={5} className="usermgr__empty">個別付与はありません。</td>
              </tr>
            )}
            {[...grants]
              .sort((a, b) => a.email.localeCompare(b.email))
              .map((g) => (
                <tr key={`${g.email}:${g.module}:${g.action}`}>
                  <td>{g.email}</td>
                  <td>
                    {moduleActionLabel(g.module, g.action)}
                    <span className="permpage__code"><code>{g.module}.{g.action}</code></span>
                  </td>
                  <td>{g.granted_by_email ?? "—"}</td>
                  <td>{g.created_at.slice(0, 10)}</td>
                  <td style={{ textAlign: "right" }}>
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => onRemove(g.email, g.module, g.action)}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
