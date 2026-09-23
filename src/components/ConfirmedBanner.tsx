import { useEffect, useRef, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { useUiStore } from "../store/useUiStore";
import { useAuthStore } from "../store/useAuthStore";
import { getAuthor } from "../lib/author";

/**
 * Header-mounted "確定版" status indicator. Renders a small ⭐ badge in
 * OrgSubNav whenever the editor is on a 確定版 file; clicking opens a
 * popover that explains the master-file behavior and offers the
 * "別案として複製" affordance. Replaces the old full-width banner.
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

  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const file = currentVersionId
    ? versions.find((v) => v.id === currentVersionId)
    : null;

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

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
    const loaded = await getSnapshot(row.id);
    if (loaded) {
      setViewOnly(false);
      replaceNodes(loaded.nodes, {
        versionId: row.id,
        versionLabel: row.name,
        rev: loaded.rev,
      });
    }
    setToast({ kind: "info", message: `「${trimmed}」を別案として作成しました` });
    setOpen(false);
  }

  return (
    <div className="hdrAlert" ref={wrapRef}>
      <button
        className={`hdrAlert__btn hdrAlert__btn--confirmed ${open ? "is-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={`確定版（マスター${period ? `／${period}` : ""}）`}
      >
        <span className="hdrAlert__icon" aria-hidden>⭐</span>
        <span className="hdrAlert__label">確定版{period ? `／${period}` : ""}</span>
      </button>
      {open && (
        <div className="hdrAlert__panel" role="dialog">
          <div className="hdrAlert__head">
            <strong>確定版（マスター{period ? `／${period}` : ""}）</strong>
            <p className="hdrAlert__desc">
              マスター組織図として保存中です。編集→保存で確定版のまま更新されます。
              別案を試す場合は下のボタンを使用してください。
            </p>
          </div>
          <div className="hdrAlert__actions">
            <button className="btn btn--primary btn--xs" onClick={duplicateAsDraft}>
              別案として複製
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatPeriod(period: string): string {
  const m = /^(\d{4})-(\d{1,2})/.exec(period);
  if (!m) return period;
  return `${m[1]}年${parseInt(m[2], 10)}月度`;
}
