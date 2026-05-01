import { useUiStore } from "../store/useUiStore";

/**
 * Secondary navigation shown ONLY while the user is in the "組織図" section.
 * Lets them swap between the chart editor and the HR announcements list
 * without leaving the section. Renders nothing in other sections — they
 * have their own dedicated layouts.
 */
export function OrgSubNav() {
  const route = useUiStore((s) => s.route);
  const navigate = useUiStore((s) => s.navigate);

  // Editor is the "main" sub-tab; announcements (list and detail) is the
  // secondary one. Detail counts as "発令" so the active state stays right
  // when drilled into a single announcement.
  const sub: "editor" | "announcements" =
    route.name === "announcements" || route.name === "announcement"
      ? "announcements"
      : "editor";

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
    </nav>
  );
}
