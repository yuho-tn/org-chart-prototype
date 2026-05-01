import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useUiStore } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { getAuthor } from "../lib/author";

/**
 * Slim banner shown directly under the TopBar whenever the editor is
 * displaying a 確定版 file. Confirmed files are immutable by spec, so
 * the banner doubles as the affordance the user needs: a one-click
 * 「複製して編集」 button that creates a fresh draft from this snapshot
 * and switches to it. The user does NOT have to navigate to the side
 * panel to find this action.
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

  async function duplicateAndEdit() {
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
    setToast({ kind: "info", message: `「${trimmed}」を作成しました。編集できます。` });
  }

  return (
    <div className="confirmed-banner">
      <span className="confirmed-banner__label">
        🔒 確定版（{period ?? "FIX登録済"}）— 閲覧のみ
      </span>
      <span className="confirmed-banner__hint">
        編集する場合は複製してから行ってください。元の確定版は変わりません。
      </span>
      <button className="btn btn--primary btn--xs" onClick={duplicateAndEdit}>
        複製して編集
      </button>
    </div>
  );
}

function formatPeriod(period: string): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(period);
  if (!m) return period;
  return `${m[1]}年${parseInt(m[2], 10)}月度`;
}
