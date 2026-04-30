import { useEffect, useState } from "react";
import { getAuthor, setAuthor } from "../lib/author";

/**
 * On first launch (no author stored), force the user to enter a display name.
 * The name is used as the "created by" field on saved versions.
 */
export function AuthorPrompt({ onReady }: { onReady: () => void }) {
  const [name, setName] = useState("");
  const [needsName, setNeedsName] = useState(() => !getAuthor());

  useEffect(() => {
    if (!needsName) onReady();
  }, [needsName, onReady]);

  if (!needsName) return null;

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setAuthor(trimmed);
    setNeedsName(false);
    onReady();
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3 className="modal__title">あなたの名前を教えてください</h3>
        <p className="modal__body">
          保存したバージョンに「作成者」として表示されます。チーム内で識別しやすい名前を入力してください。
          <br />
          （後で右上のメニューから変更可能です）
        </p>
        <input
          className="field__input"
          autoFocus
          placeholder="例：丹野 裕鵬"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <div className="modal__actions" style={{ marginTop: 14 }}>
          <button className="btn btn--primary" disabled={!name.trim()} onClick={submit}>
            設定して開始
          </button>
        </div>
      </div>
    </div>
  );
}
