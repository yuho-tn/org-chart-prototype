import { useOrgStore } from "../store/useOrgStore";
import { useUiStore } from "../store/useUiStore";

/**
 * Secondary navigation shown ONLY while the user is in the "組織図" section.
 * Lets them swap between the chart editor and the HR announcements list
 * without leaving the section. Renders nothing in other sections — they
 * have their own dedicated layouts.
 *
 * In editor mode this also exposes the "組織図ファイル" trigger that opens
 * the FilesDrawer; files are conceptually above the editor tools so they
 * live up here rather than getting buried at the bottom of the sidebar.
 */
export function OrgSubNav() {
  const route = useUiStore((s) => s.route);
  const navigate = useUiStore((s) => s.navigate);
  const filesDrawerOpen = useUiStore((s) => s.filesDrawerOpen);
  const setFilesDrawerOpen = useUiStore((s) => s.setFilesDrawerOpen);
  const currentVersionLabel = useOrgStore((s) => s.currentVersionLabel);
  const dirty = useOrgStore((s) => s.dirty);

  // Editor is the "main" sub-tab; announcements (list and detail) is the
  // secondary one. Detail counts as "発令" so the active state stays right
  // when drilled into a single announcement.
  const sub: "editor" | "announcements" =
    route.name === "announcements" || route.name === "announcement"
      ? "announcements"
      : "editor";

  const fileLabel = currentVersionLabel
    ? `${currentVersionLabel}${dirty ? "（未保存）" : ""}`
    : "新規ファイル";

  return (
    <nav className="orgsub" role="tablist">
      <button
        role="tab"
        aria-selected={sub === "editor"}
        className={`orgsub__tab ${sub === "editor" ? "is-active" : ""}`}
        onClick={() => navigate({ name: "editor" })}
      >
        編集
      </button>
      <button
        role="tab"
        aria-selected={sub === "announcements"}
        className={`orgsub__tab ${sub === "announcements" ? "is-active" : ""}`}
        onClick={() => navigate({ name: "announcements" })}
      >
        人事発令
      </button>
      <div className="orgsub__spacer" />
      {sub === "editor" && (
        <button
          className={`orgsub__file ${filesDrawerOpen ? "is-open" : ""}`}
          onClick={() => setFilesDrawerOpen(!filesDrawerOpen)}
          aria-expanded={filesDrawerOpen}
          title="組織図ファイル一覧を開く（下書き／確定版の切替・複製・削除など）"
        >
          <span className="orgsub__fileIcon" aria-hidden>📁</span>
          <span className="orgsub__fileLabel">ファイル：{fileLabel}</span>
          <span className="orgsub__fileCaret" aria-hidden>▾</span>
        </button>
      )}
    </nav>
  );
}
