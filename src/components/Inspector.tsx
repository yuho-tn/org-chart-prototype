import { useEffect, useState } from "react";
import { useOrgStore } from "../store/useOrgStore";
import { descendantsOf } from "../lib/layout";
import type { DeptCategory, OrgNode, PersonRole } from "../lib/types";
import { PALETTE } from "../lib/palette";

const CATEGORIES: DeptCategory[] = ["ROOT", "Exe", "DIV", "TM", "Unit", "DEPT"];
const ROLES: { value: PersonRole; label: string }[] = [
  { value: null, label: "メンバー（役職なし）" },
  { value: "CEO", label: "CEO（最高経営責任者）" },
  { value: "COO", label: "COO（最高執行責任者）" },
  { value: "CFO", label: "CFO（最高財務責任者）" },
  { value: "CTO", label: "CTO（最高技術責任者）" },
  { value: "CMO", label: "CMO（最高マーケティング責任者）" },
  { value: "CHRO", label: "CHRO（最高人事責任者）" },
  { value: "DM", label: "DM（DIVマネージャー）" },
  { value: "TM", label: "TM（チームマネージャー）" },
  { value: "UL", label: "UL（ユニットリーダー）" },
  { value: "CTL", label: "CTL（副リーダー）" },
  { value: "TL", label: "TL（チームリーダー）" },
];

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
  const setRole = useOrgStore((s) => s.setRole);
  const setExecutive = useOrgStore((s) => s.setExecutive);
  const setCategory = useOrgStore((s) => s.setCategory);
  const setColor = useOrgStore((s) => s.setColor);
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
        <p>ノード（部署カードまたは人員チップ）を選択すると詳細が表示されます。</p>
      </aside>
    );
  }

  const descCount = descendantsOf(nodes, selected.id).length;

  function commitRename() {
    if (selected && name.trim() && name !== selected.name) {
      rename(selected.id, name.trim());
    }
  }

  return (
    <>
      <aside className="inspector">
        <div className={`badge badge--${selected.kind}`}>
          {selected.kind === "department" ? `部署 / ${selected.category ?? "DEPT"}` : "人員"}
        </div>
        <label className="field">
          <span className="field__label">名前</span>
          <input
            className="field__input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
          />
        </label>

        {selected.kind === "department" && (
          <>
            <label className="field">
              <span className="field__label">種別</span>
              <select
                className="field__input"
                value={selected.category ?? "DEPT"}
                onChange={(e) => setCategory(selected.id, e.target.value as DeptCategory)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span className="field__label">カラー</span>
              <div className="color-grid">
                {PALETTE.map((c, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`color-swatch ${selected.colorIndex === i ? "is-active" : ""}`}
                    style={{ background: c.header, borderColor: c.border }}
                    onClick={() => setColor(selected.id, i)}
                    aria-label={`色 ${i + 1}`}
                  />
                ))}
              </div>
            </div>
          </>
        )}

        {selected.kind === "person" && (
          <>
          <label className="field">
            <span className="field__label">役職</span>
            <select
              className="field__input"
              value={selected.roleLabel ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setRole(selected.id, (v === "" ? null : (v as PersonRole)));
              }}
            >
              {ROLES.map((r) => (
                <option key={r.label} value={r.value ?? ""}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">役員フラグ</span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!selected.isExecutive}
                onChange={(e) => setExecutive(selected.id, e.target.checked)}
              />
              <span>
                役員として扱う（DIVを横断するポジション）
                <br />
                <small style={{ color: "var(--text-muted)" }}>
                  ONかつ親がROOTのとき、役員バンドに表示。DIVカード内にドラッグするとその部署のリーダー扱いに切り替わります。
                </small>
              </span>
            </label>
          </label>
          </>
        )}

        <div className="field">
          <span className="field__label">所属</span>
          <span className="field__value">{breadcrumb(nodes, selected)}</span>
        </div>
        {selected.kind === "department" && (
          <div className="field">
            <span className="field__label">配下</span>
            <span className="field__value">{descCount}件</span>
          </div>
        )}

        <button className="btn btn--danger" onClick={() => setConfirmOpen(true)}>
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
  const showThreeWay = target.kind === "department" && descCount > 0;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal__title">削除の確認</h3>
        {showThreeWay ? (
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
