import { useMemo } from "react";
import { usePresenceStore, type Peer } from "../store/usePresenceStore";

const MAX_VISIBLE = 5;

/** OrgSubNav-mounted avatar strip showing every other user currently
 *  connected to the realtime channel. Self is intentionally hidden — the
 *  user already sees themselves in the global header. */
export function PresenceAvatars() {
  const peers = usePresenceStore((s) => s.peers);

  const unique = useMemo(() => {
    // A user with multiple tabs shows up multiple times; collapse by email
    // and prefer the latest-joined entry.
    const map = new Map<string, Peer>();
    for (const p of peers) {
      const ex = map.get(p.email);
      if (!ex || ex.joined_at < p.joined_at) map.set(p.email, p);
    }
    return Array.from(map.values()).sort((a, b) => a.joined_at - b.joined_at);
  }, [peers]);

  if (unique.length === 0) return null;

  const visible = unique.slice(0, MAX_VISIBLE);
  const overflow = unique.length - visible.length;

  return (
    <div className="presence" aria-label="共同編集中のメンバー">
      {visible.map((p) => {
        const label = p.display_name ?? p.email;
        const initial = label[0]?.toUpperCase() ?? "?";
        const tip =
          p.display_name && p.display_name !== p.email
            ? `${p.display_name}（${p.email}）`
            : p.email;
        return (
          <span
            key={p.email}
            className="presence__avatar"
            style={{ background: p.color }}
            title={tip}
          >
            {initial}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          className="presence__avatar presence__avatar--overflow"
          title={unique
            .slice(MAX_VISIBLE)
            .map((p) => p.display_name ?? p.email)
            .join(", ")}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
