import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useUiStore } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { getAuthor } from "../lib/author";

/**
 * Slim banner shown directly under the TopBar whenever the editor is
 * displaying a 確定版 file. Confirmed files are the "master" org chart —
 * they remain editable and saving updates the confirmed snapshot in place.
 * The banner makes the FIX status (and 確定期間) explicit, and offers a
 * "複製して別案を作成" affordance for users who want to fork without
 * touching the master.
 */
export function ConfirmedBanner() {
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const dirty = useOrgStore((s) => s.dirty);
  const setToast = useOrgStore((s) => s.setToast);
  const versions = useVersionsStore((s) => s.versions);
  const duplicate = useVersionsStore((s) => s.duplicate);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const setViewOnly = useUiStore((s) => s.setViewOnly);
  const currentUser = useAuthStore((s) => s.currentUser);

  const file = currentVersionId
    ? versions.find((v) => v.id === currentVersionId)
    : null;

  if (!file?.is_confirmed) return null;
  if (currentUser?.role === "viewer") return null;

  const period = file.confirmed_period
    ? formatPeriod(file.confirmed_period)
    : null;

  async function duplicateAsDraft() {
    if (!file) return;
    if (dirty) {
      const ok = window.confirm(
        "未保存の変更があります。複製を開くと現在の変更は失われます。続けますか？",
      );
      if (!ok) return;
    }
    const author = getAuthor() ?? currentUser?.display_name ?? "";
    const dupName = window.prompt(
      "複製したファイルの名前を入力してください",
      `${file.name} のコピー`,
    );
    if (dupName === null) return;
    const trimmed = dupName.trim();
    if (!trimmed) return;
    const row = await duplicate(file.id, trimmed, author, currentUser?.email ?? null);
    if (!row) {
      setToast({ kind: "error", message: "複製に失敗しました" });
      return;
    }
    const nodes = await getSnapshot(row.id);
    if (nodes) {
      setViewOnly(false);
      replaceNodes(nodes, { versionId: row.id, versionLabel: row.name });
    }
    setToast({ kind: "info", message: `「${trimmed}」を別案として作成しました` });
  }

  return (
    <div className="confirmed-banner">
      <span className="confirmed-banner__label">
        ⭐ 確定版（マスター{period ? `／${period}` : ""}）
      </span>
      <span className="confirmed-banner__hint">
        マスター組織図として保存中です。編集→保存で確定版のまま更新されます。
        別案を試す場合は右の「別案として複製」を使用してください。
      </span>
      <button className="btn btn--ghost btn--xs" onClick={duplicateAsDraft}>
        別案として複製
      </button>
    </div>
  );
}

function formatPeriod(period: string): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(period);
  if (!m) return period;
  return `${m[1]}年${parseInt(m[2], 10)}月度`;
}
