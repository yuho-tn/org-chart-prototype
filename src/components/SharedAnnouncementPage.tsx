import { useEffect, useState } from "react";
import {
  useAnnouncementsStore,
  type AnnouncementRow,
} from "../store/useAnnouncementsStore";
import { AnnouncementPaper } from "./AnnouncementDetailPage";

/**
 * Anonymous, no-login read-only view of an HR announcement, reached via a
 * `?a=<token>` share link. Loads the row through the SECURITY DEFINER RPC
 * (announcement_by_share_token) so the hr_announcements table stays fully
 * anon-locked — only a valid token yields a single published row.
 */
export function SharedAnnouncementPage({ token }: { token: string }) {
  const getBySharedToken = useAnnouncementsStore((s) => s.getBySharedToken);
  const [row, setRow] = useState<AnnouncementRow | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    (async () => {
      const r = await getBySharedToken(token);
      if (cancelled) return;
      setRow(r);
      setState(r ? "ready" : "error");
    })();
    return () => {
      cancelled = true;
    };
  }, [token, getBySharedToken]);

  return (
    <div className="app app--viewer">
      <header className="topbar topbar--viewer">
        <div className="topbar__brand">TalentHub</div>
        <span className="topbar__badge is-saved">共有（閲覧モード）</span>
        <div className="topbar__spacer" />
        {state === "ready" && (
          <button className="btn" onClick={() => window.print()} title="印刷">
            🖨 印刷
          </button>
        )}
      </header>
      <div className="sharedann">
        {state === "loading" && <p className="sharedann__msg">読み込み中…</p>}
        {state === "error" && (
          <p className="sharedann__msg">
            この共有リンクは無効か、期限切れの可能性があります（発令が非公開に戻されたか、リンクが無効化された場合も表示されません）。
          </p>
        )}
        {state === "ready" && row && (
          <div className="anndetail anndetail--shared">
            <AnnouncementPaper row={row} />
          </div>
        )}
      </div>
    </div>
  );
}
