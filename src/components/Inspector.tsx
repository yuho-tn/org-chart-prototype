import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { descendantsOf } from "../lib/layout";
import type { OrgNode } from "../lib/types";

function breadcrumb(nodes: OrgNode[], node: OrgNode): string {
  const parts: string[] = [];
  let cur: OrgNode | undefined = node;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? nodes.find((n) => n.id === cur!.parentId) : undefined;
  }
  return parts.join(" / ");
}

export function Inspector() {
  const nodes = useOrgStore((s) => s.nodes);
  const selectedId = useOrgStore((s) => s.selectedId);
  const rename = useOrgStore((s) => s.rename);
  const deleteNode = useOrgStore((s) => s.deleteNode);

  const selected = nodes.find((n) => n.id === selectedId) ?? null;
  const [name, setName] = useState(selected?.name ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setName(selected?.name ?? "");
  }, [selectedId, selected?.name]);

  if (!selected) {
    return (
      <aside className="inspector inspector--empty">
        <p>ノードを選択すると詳細が表示されます。</p>
      </aside>
    );
  }

  const descCount = descendantsOf(nodes, selected.id).length;

  function commitRename() {
    if (selected && name.trim() && name !== selected.name) {
      rename(selected.id, name.trim());
    }
  }

  function handleDeleteClick() {
    if (selected!.kind === "department" && descCount > 0) {
      setConfirmOpen(true);
    } else {
      // person delete or empty department: still confirm
      setConfirmOpen(true);
    }
  }

  return (
    <>
      <aside className="inspector">
        <div className={`badge badge--${selected.kind}`}>
          {selected.kind === "department" ? "部署" : "人員"}
        </div>
        <label className="field">
          <span className="field__label">名前</span>
          <input
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
        </label>
        <div className="field">
          <span className="field__label">所属</span>
          <span className="field__value">{breadcrumb(nodes, selected)}</span>
        </div>
        <div className="field">
          <span className="field__label">配下</span>
          <span className="field__value">{descCount}件</span>
        </div>
        <button className="btn btn--danger" onClick={handleDeleteClick}>
          このノードを削除
        </button>
      </aside>

      {confirmOpen && (
        <DeleteModal
          target={selected}
          descCount={descCount}
          onCancel={() => setConfirmOpen(false)}
          onCascade={() => {
            deleteNode(selected.id, "cascade");
            setConfirmOpen(false);
          }}
          onPromote={() => {
            deleteNode(selected.id, "promoteToRoot");
            setConfirmOpen(false);
          }}
        />
      )}
    </>
  );
}

function DeleteModal({
  target,
  descCount,
  onCancel,
  onCascade,
  onPromote,
}: {
  target: OrgNode;
  descCount: number;
  onCancel: () => void;
  onCascade: () => void;
  onPromote: () => void;
}) {
  const hasChildren = descCount > 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">削除の確認</h3>
        {hasChildren ? (
          <>
            <p className="modal__body">
              <strong>{target.name}</strong> には配下 {descCount} 件があります。どのように処理しますか？
            </p>
            <div className="modal__actions modal__actions--column">
              <button className="btn btn--danger" onClick={onCascade}>
                a) 配下ごとまとめて削除
              </button>
              <button className="btn" onClick={onPromote}>
                b) 子をルートへ移動して、このノードのみ削除
              </button>
              <button className="btn btn--ghost" onClick={onCancel}>
                c) キャンセル
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal__body">
              <strong>{target.name}</strong> を削除します。よろしいですか？
            </p>
            <div className="modal__actions">
              <button className="btn btn--ghost" onClick={onCancel}>
                キャンセル
              </button>
              <button className="btn btn--danger" onClick={onCascade}>
                削除する
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
