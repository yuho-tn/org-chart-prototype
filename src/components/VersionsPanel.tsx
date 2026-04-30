import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore, isSupabaseConfigured } from "../store/useVersionsStore";
import { SaveVersionDialog } from "./SaveVersionDialog";

function timeAgo(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "たった今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}日前`;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fullDateTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function VersionsPanel() {
  const versions = useVersionsStore((s) => s.versions);
  const loading = useVersionsStore((s) => s.loading);
  const error = useVersionsStore((s) => s.error);
  const refresh = useVersionsStore((s) => s.refresh);
  const getSnapshot = useVersionsStore((s) => s.getSnapshot);
  const remove = useVersionsStore((s) => s.remove);

  const dirty = useOrgStore((s) => s.dirty);
  const currentVersionId = useOrgStore((s) => s.currentVersionId);
  const replaceNodes = useOrgStore((s) => s.replaceNodes);
  const setToast = useOrgStore((s) => s.setToast);

  const [showSave, setShowSave] = useState(false);

  useEffect(() => {
    if (isSupabaseConfigured) refresh();
  }, [refresh]);

  async function handleLoad(id: string, name: string) {
    if (dirty) {
      const ok = window.confirm(
        "未保存の変更があります。このバージョンを読み込むと変更は失われます。続けますか？",
      );
      if (!ok) return;
    }
    const nodes = await getSnapshot(id);
    if (!nodes) {
      setToast({ kind: "error", message: "バージョンの読み込みに失敗しました" });
      return;
    }
    replaceNodes(nodes, { versionId: id, versionLabel: name });
  }

  async function handleDelete(id: string, name: string, e: React.MouseEvent) {
    e.stopPropagation();
    const ok = window.confirm(`バージョン「${name}」を削除しますか？この操作は取り消せません。`);
    if (!ok) return;
    const success = await remove(id);
    setToast(
      success
        ? { kind: "info", message: `「${name}」を削除しました` }
        : { kind: "error", message: "削除に失敗しました" },
    );
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="versions">
        <header className="versions__header">
          <h2 className="sidebar__title" style={{ margin: 0 }}>バージョン履歴</h2>
        </header>
        <p className="versions__empty">
          サーバ未設定です。<code>VITE_SUPABASE_URL</code> と
          <code>VITE_SUPABASE_ANON_KEY</code> を設定してください。
        </p>
      </section>
    );
  }

  return (
    <>
      <section className="versions">
        <header className="versions__header">
          <h2 className="sidebar__title" style={{ margin: 0 }}>バージョン履歴</h2>
          <button
            className="btn btn--ghost btn--xs"
            onClick={() => refresh()}
            title="一覧を再読み込み"
          >
            ↻
          </button>
        </header>

        <button className="btn btn--primary" onClick={() => setShowSave(true)}>
          ＋現状をバージョン保存
        </button>

        {error && <p className="versions__error">{error}</p>}

        <div className="versions__list">
          {loading && versions.length === 0 && (
            <p className="versions__empty">読み込み中…</p>
          )}
          {!loading && versions.length === 0 && (
            <p className="versions__empty">
              保存済みバージョンはまだありません。
              <br />
              「＋現状をバージョン保存」から最初の一件を作成してください。
            </p>
          )}
          {versions.map((v) => {
            const isActive = currentVersionId === v.id;
            return (
              <div
                key={v.id}
                className={`version-card ${isActive ? "is-active" : ""}`}
                onClick={() => handleLoad(v.id, v.name)}
                role="button"
                tabIndex={0}
                title={fullDateTime(v.created_at)}
              >
                <div className="version-card__head">
                  <span className="version-card__name">{v.name}</span>
                  <button
                    className="version-card__delete"
                    onClick={(e) => handleDelete(v.id, v.name, e)}
                    aria-label="削除"
                    title="削除"
                  >
                    ✕
                  </button>
                </div>
                <div className="version-card__meta">
                  <span className="version-card__author">{v.author}</span>
                  <span className="version-card__sep">·</span>
                  <span className="version-card__time">{timeAgo(v.created_at)}</span>
                </div>
                {v.note && <div className="version-card__note">{v.note}</div>}
                {isActive && <div className="version-card__active">読み込み中</div>}
              </div>
            );
          })}
        </div>
      </section>

      {showSave && <SaveVersionDialog onClose={() => setShowSave(false)} />}
    </>
  );
}
