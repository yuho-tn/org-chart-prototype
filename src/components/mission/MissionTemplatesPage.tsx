import { useEffect, useMemo, useState } from "react";
import { useMissionsStore, periodLabel } from "../../store/useMissionsStore";
import { useProfilesStore } from "../../store/useProfilesStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import type { PeriodCode } from "../../lib/supabase";
import {
  DEFAULT_TEMPLATE_DEFINITION,
  type MissionTemplateRow,
  type MissionTemplateStatus,
} from "../../lib/mission";
import { ConfirmDialog } from "../ConfirmDialog";

const STATUS_LABEL: Record<MissionTemplateStatus, string> = {
  draft: "下書き",
  published: "公開中",
  archived: "アーカイブ",
};

/**
 * #/missions/templates — テンプレート一覧（mission.manage のみ）。
 * 新規作成は period 選択＋タイトル入力で雛形 definition（VISION/CREDO/
 * 6SENSE/成果）を投入して draft を作り、そのまま編集画面へ遷移する。
 */
export function MissionTemplatesPage() {
  const templates = useMissionsStore((s) => s.templates);
  const sheets = useMissionsStore((s) => s.sheets);
  const periods = useMissionsStore((s) => s.periods);
  const loaded = useMissionsStore((s) => s.loaded);
  const loading = useMissionsStore((s) => s.loading);
  const error = useMissionsStore((s) => s.error);
  const refresh = useMissionsStore((s) => s.refresh);
  const saveTemplate = useMissionsStore((s) => s.saveTemplate);
  const publishTemplate = useMissionsStore((s) => s.publishTemplate);
  const archiveTemplate = useMissionsStore((s) => s.archiveTemplate);
  const duplicateTemplate = useMissionsStore((s) => s.duplicateTemplate);

  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const can = useProfilesStore((s) => s.can);
  const setToast = useOrgStore((s) => s.setToast);
  const navigate = useUiStore((s) => s.navigate);

  useEffect(() => {
    refresh();
    if (!profilesLoaded) refreshProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canManage = can("mission", "manage");

  // 新規作成フォーム
  const [newPeriod, setNewPeriod] = useState<string>("");
  const [newTitle, setNewTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const defaultPeriod = periods[periods.length - 1]?.code ?? "";
  const effectiveNewPeriod = newPeriod || defaultPeriod;

  // 操作確認ダイアログ
  const [publishing, setPublishing] = useState<MissionTemplateRow | null>(null);
  const [archiving, setArchiving] = useState<MissionTemplateRow | null>(null);
  const [duplicating, setDuplicating] = useState<MissionTemplateRow | null>(null);
  const [dupPeriod, setDupPeriod] = useState<string>("");

  const sheetCountByTemplate = useMemo(() => {
    const map: Record<string, number> = {};
    for (const s of sheets) map[s.template_id] = (map[s.template_id] ?? 0) + 1;
    return map;
  }, [sheets]);

  const sorted = useMemo(
    () =>
      [...templates].sort(
        (a, b) =>
          (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
          a.title.localeCompare(b.title, "ja"),
      ),
    [templates],
  );

  async function handleCreate() {
    if (!effectiveNewPeriod || !newTitle.trim()) return;
    setCreating(true);
    const id = crypto.randomUUID();
    const res = await saveTemplate({
      id,
      period: effectiveNewPeriod as PeriodCode,
      title: newTitle.trim(),
      definition: DEFAULT_TEMPLATE_DEFINITION,
      deadlines: {},
      status: "draft",
      calc_version: 1,
    });
    setCreating(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "作成に失敗しました" });
      return;
    }
    setNewTitle("");
    setToast({ kind: "info", message: "テンプレートを作成しました（下書き）" });
    navigate({ name: "mission_template", id });
  }

  async function handlePublish() {
    if (!publishing) return;
    const res = await publishTemplate(publishing.id);
    setPublishing(null);
    setToast(
      res.ok
        ? { kind: "info", message: "テンプレートを公開しました（以後編集不可）" }
        : { kind: "error", message: res.reason ?? "公開に失敗しました" },
    );
  }

  async function handleArchive() {
    if (!archiving) return;
    const res = await archiveTemplate(archiving.id);
    setArchiving(null);
    setToast(
      res.ok
        ? { kind: "info", message: "テンプレートをアーカイブしました" }
        : { kind: "error", message: res.reason ?? "アーカイブに失敗しました" },
    );
  }

  async function handleDuplicate() {
    if (!duplicating) return;
    const period = (dupPeriod || duplicating.period) as PeriodCode;
    const res = await duplicateTemplate(duplicating.id, period);
    setDuplicating(null);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "複製に失敗しました" });
      return;
    }
    setToast({ kind: "info", message: "テンプレートを複製しました（下書き）" });
    if (res.newId) navigate({ name: "mission_template", id: res.newId });
  }

  if (loaded && !canManage) {
    return (
      <main className="page">
        <p className="versions__error">このページを表示する権限がありません（mission.manage が必要です）。</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">ミッションテンプレート</h1>
          <p className="page__subtitle">
            期ごとの設問テンプレートを管理します。公開（published）後は内容を変更できません —
            変更したい場合は複製して新しい下書きを作ってください。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--ghost" onClick={() => navigate({ name: "missions" })}>
            ← ミッションへ戻る
          </button>
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      <div className="mission__toolbar">
        <label className="mission__toolbarLabel">
          期:
          <select
            className="field__input field__input--xs"
            value={effectiveNewPeriod}
            onChange={(e) => setNewPeriod(e.target.value)}
          >
            {periods.map((p) => (
              <option key={p.code} value={p.code}>
                {periodLabel(p.code, periods)}
              </option>
            ))}
          </select>
        </label>
        <input
          className="field__input"
          style={{ flex: "1 1 240px" }}
          placeholder="テンプレート名（例: 5期上期 ミッションシート）"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
        />
        <button
          className="btn btn--primary"
          disabled={creating || !newTitle.trim() || !effectiveNewPeriod}
          onClick={handleCreate}
        >
          {creating ? "作成中…" : "＋新規作成（雛形から）"}
        </button>
      </div>

      <div className="emppage__tableWrap">
        <table className="empmgr__table emppage__table">
          <thead>
            <tr>
              <th style={{ width: 110 }}>期</th>
              <th>テンプレート名</th>
              <th style={{ width: 110 }}>ステータス</th>
              <th style={{ width: 90, textAlign: "right" }}>発行数</th>
              <th style={{ width: 120 }}>更新日</th>
              <th style={{ width: 260 }} />
            </tr>
          </thead>
          <tbody>
            {loading && !loaded && (
              <tr>
                <td colSpan={6} className="usermgr__empty">読み込み中…</td>
              </tr>
            )}
            {loaded && sorted.length === 0 && (
              <tr>
                <td colSpan={6} className="usermgr__empty">
                  テンプレートがまだありません。上のフォームから作成してください。
                </td>
              </tr>
            )}
            {sorted.map((t) => (
              <tr key={t.id}>
                <td>{periodLabel(t.period, periods)}</td>
                <td>{t.title}</td>
                <td>
                  <span className={`mission__statusbadge mission__statusbadge--${t.status}`}>
                    {STATUS_LABEL[t.status]}
                  </span>
                </td>
                <td style={{ textAlign: "right" }}>{sheetCountByTemplate[t.id] ?? 0}</td>
                <td>{t.updated_at?.slice(0, 10) ?? "—"}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => navigate({ name: "mission_template", id: t.id })}
                  >
                    {t.status === "draft" ? "編集" : "表示"}
                  </button>{" "}
                  <button
                    className="btn btn--ghost btn--xs"
                    onClick={() => {
                      setDupPeriod(t.period);
                      setDuplicating(t);
                    }}
                  >
                    複製
                  </button>{" "}
                  {t.status === "draft" && (
                    <button
                      className="btn btn--primary btn--xs"
                      onClick={() => setPublishing(t)}
                    >
                      公開
                    </button>
                  )}
                  {t.status === "published" && (
                    <button
                      className="btn btn--ghost btn--xs"
                      onClick={() => setArchiving(t)}
                    >
                      アーカイブ
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {publishing && (
        <ConfirmDialog
          title="テンプレートを公開する"
          message={
            <>
              「{publishing.title}」を公開します。<strong>公開後はテンプレートの内容
              （設問・締切・期）を編集できません</strong>。発行はこの公開テンプレートから行われます。
              よろしいですか？
            </>
          }
          confirmLabel="公開する"
          onConfirm={handlePublish}
          onCancel={() => setPublishing(null)}
        />
      )}

      {archiving && (
        <ConfirmDialog
          title="テンプレートをアーカイブする"
          message={
            <>
              「{archiving.title}」をアーカイブします。新規発行の対象から外れます
              （発行済みシートはそのまま残ります）。よろしいですか？
            </>
          }
          confirmLabel="アーカイブする"
          variant="danger"
          onConfirm={handleArchive}
          onCancel={() => setArchiving(null)}
        />
      )}

      {duplicating && (
        <ConfirmDialog
          title="テンプレートを複製する"
          message={<>「{duplicating.title}」を下書きとして複製します。複製先の期を選択してください。</>}
          confirmLabel="複製する"
          onConfirm={handleDuplicate}
          onCancel={() => setDuplicating(null)}
        >
          <div style={{ margin: "8px 0 4px" }}>
            <select
              className="field__input"
              value={dupPeriod || duplicating.period}
              onChange={(e) => setDupPeriod(e.target.value)}
            >
              {periods.map((p) => (
                <option key={p.code} value={p.code}>
                  {periodLabel(p.code, periods)}
                </option>
              ))}
            </select>
          </div>
        </ConfirmDialog>
      )}
    </main>
  );
}
