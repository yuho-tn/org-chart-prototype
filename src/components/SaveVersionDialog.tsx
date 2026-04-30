import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { useVersionsStore } from "../store/useVersionsStore";
import { getAuthor } from "../lib/author";

function defaultName(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SaveVersionDialog({ onClose }: { onClose: () => void }) {
  const nodes = useOrgStore((s) => s.nodes);
  const markClean = useOrgStore((s) => s.markClean);
  const setToast = useOrgStore((s) => s.setToast);
  const save = useVersionsStore((s) => s.save);

  const [name, setName] = useState(defaultName());
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const author = getAuthor() ?? "";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit() {
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    const row = await save({
      name: name.trim(),
      author,
      note: note.trim() || null,
      nodes,
    });
    setSubmitting(false);
    if (!row) {
      setError("保存に失敗しました。ネットワーク／設定をご確認ください。");
      return;
    }
    markClean({ versionId: row.id, versionLabel: row.name });
    setToast({ kind: "info", message: `バージョン「${row.name}」を保存しました` });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">バージョンとして保存</h3>
        <p className="modal__body" style={{ margin: "0 0 12px" }}>
          現在の組織図をサーバに保存します。後でこのバージョンに戻れるようになります。
        </p>

        <label className="field">
          <span className="field__label">バージョン名（必須）</span>
          <input
            className="field__input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：2026春・新体制"
          />
        </label>

        <label className="field" style={{ marginTop: 10 }}>
          <span className="field__label">メモ（任意）</span>
          <textarea
            className="field__input"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="このバージョンで何を変更したかなど"
          />
        </label>

        <div className="field" style={{ marginTop: 10 }}>
          <span className="field__label">作成者</span>
          <span className="field__value">{author || "（未設定）"}</span>
        </div>

        {error && (
          <p style={{ color: "var(--danger)", fontSize: 12, margin: "10px 0 0" }}>{error}</p>
        )}

        <div className="modal__actions" style={{ marginTop: 16 }}>
          <button className="btn btn--ghost" onClick={onClose} disabled={submitting}>
            キャンセル
          </button>
          <button
            className="btn btn--primary"
            onClick={submit}
            disabled={!name.trim() || !author || submitting}
          >
            {submitting ? "保存中…" : "保存する"}
          </button>
        </div>
      </div>
    </div>
  );
}
