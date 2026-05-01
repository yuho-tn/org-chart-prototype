import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../store/useUiStore";
import { useAnnouncementsStore, type AnnouncementRow } from "../store/useAnnouncementsStore";
import { useAuthStore } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import {
  formatPeriodHeading,
  type AnnouncementHire,
  type AnnouncementLeave,
  type AnnouncementMove,
  type AnnouncementPayload,
  type AnnouncementPromotion,
} from "../lib/announcement";

export function AnnouncementDetailPage({ id }: { id: string }) {
  const navigate = useUiStore((s) => s.navigate);
  const getById = useAnnouncementsStore((s) => s.getById);
  const update = useAnnouncementsStore((s) => s.update);
  const currentUser = useAuthStore((s) => s.currentUser);
  const setToast = useOrgStore((s) => s.setToast);

  const [row, setRow] = useState<AnnouncementRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AnnouncementPayload | null>(null);
  const [draftTitle, setDraftTitle] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const r = await getById(id);
      if (cancelled) return;
      setRow(r);
      setDraft(r?.payload ?? null);
      setDraftTitle(r?.title ?? "");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, getById]);

  const isAuthor = !!row && row.created_by_email === currentUser?.email;
  const canEdit = currentUser?.role === "master" || isAuthor;

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}${window.location.pathname}#/announcements/${id}`;
  }, [id]);

  function startEdit() {
    if (!row) return;
    setDraft(row.payload);
    setDraftTitle(row.title);
    setEditing(true);
  }

  async function saveEdit() {
    if (!row || !draft) return;
    const ok = await update(row.id, { payload: draft, title: draftTitle });
    if (!ok) {
      setToast({ kind: "error", message: "保存に失敗しました" });
      return;
    }
    setRow({ ...row, payload: draft, title: draftTitle });
    setEditing(false);
    setToast({ kind: "info", message: "保存しました" });
  }

  function cancelEdit() {
    if (!row) return;
    setDraft(row.payload);
    setDraftTitle(row.title);
    setEditing(false);
  }

  async function copyShareUrl() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setToast({ kind: "info", message: "リンクをコピーしました" });
    } catch {
      // Fallback: select via prompt
      window.prompt("リンクをコピーしてください", shareUrl);
    }
  }

  if (loading) {
    return (
      <main className="page">
        <p>読み込み中…</p>
      </main>
    );
  }

  if (!row || !draft) {
    return (
      <main className="page">
        <p>発令資料が見つかりません。</p>
        <button
          className="btn"
          onClick={() => navigate({ name: "announcements" })}
        >
          一覧へ戻る
        </button>
      </main>
    );
  }

  const data = editing ? draft : row.payload;

  return (
    <div className="anndetail">
      <header className="anndetail__head no-print">
        <button
          className="btn btn--ghost"
          onClick={() => navigate({ name: "announcements" })}
        >
          ← 一覧へ
        </button>
        <div style={{ flex: 1 }} />
        {canEdit && !editing && (
          <button className="btn" onClick={startEdit}>
            編集
          </button>
        )}
        {editing && (
          <>
            <button className="btn btn--ghost" onClick={cancelEdit}>
              キャンセル
            </button>
            <button className="btn btn--primary" onClick={saveEdit}>
              保存
            </button>
          </>
        )}
        <button className="btn" onClick={() => window.print()}>
          🖨 印刷
        </button>
        <button className="btn" onClick={copyShareUrl}>
          🔗 リンクをコピー
        </button>
      </header>

      <article className="anndetail__paper">
        <header className="anndetail__paperHead">
          <p className="anndetail__period">
            {formatPeriodHeading(row.period)}
          </p>
          {editing ? (
            <input
              className="anndetail__titleInput"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
            />
          ) : (
            <h1 className="anndetail__title">{row.title}</h1>
          )}
        </header>

        <Section
          number="①"
          label="入社"
          empty="（該当なし）"
          rows={data.hires}
          editing={editing}
          renderRow={(item, set) => (
            <HireRow item={item} editing={editing} onChange={set} />
          )}
          onAdd={() =>
            setDraft({
              ...draft,
              hires: [
                ...draft.hires,
                {
                  employee_number: "",
                  full_name: "",
                  department: null,
                  position_title: null,
                  hired_at: null,
                },
              ],
            })
          }
          onRemove={(i) =>
            setDraft({ ...draft, hires: draft.hires.filter((_, idx) => idx !== i) })
          }
          onUpdate={(i, next) => {
            const arr = [...draft.hires];
            arr[i] = next;
            setDraft({ ...draft, hires: arr });
          }}
        />

        <Section
          number="②"
          label="退職"
          empty="（該当なし）"
          rows={data.leaves}
          editing={editing}
          renderRow={(item, set) => (
            <LeaveRow item={item} editing={editing} onChange={set} />
          )}
          onAdd={() =>
            setDraft({
              ...draft,
              leaves: [
                ...draft.leaves,
                {
                  employee_number: "",
                  full_name: "",
                  department: null,
                  position_title: null,
                  left_at: null,
                },
              ],
            })
          }
          onRemove={(i) =>
            setDraft({ ...draft, leaves: draft.leaves.filter((_, idx) => idx !== i) })
          }
          onUpdate={(i, next) => {
            const arr = [...draft.leaves];
            arr[i] = next;
            setDraft({ ...draft, leaves: arr });
          }}
        />

        <SectionGroup label="③ 人事異動">
          <Section
            number="A."
            label="DIV間人事"
            empty="（該当なし）"
            rows={data.div_moves}
            editing={editing}
            sub
            renderRow={(item, set) => (
              <MoveRow item={item} editing={editing} onChange={set} />
            )}
            onAdd={() =>
              setDraft({
                ...draft,
                div_moves: [
                  ...draft.div_moves,
                  { employee_number: "", full_name: "", from: "", to: "" },
                ],
              })
            }
            onRemove={(i) =>
              setDraft({
                ...draft,
                div_moves: draft.div_moves.filter((_, idx) => idx !== i),
              })
            }
            onUpdate={(i, next) => {
              const arr = [...draft.div_moves];
              arr[i] = next;
              setDraft({ ...draft, div_moves: arr });
            }}
          />
          <Section
            number="B."
            label="TM間人事"
            empty="（該当なし）"
            rows={data.tm_moves}
            editing={editing}
            sub
            renderRow={(item, set) => (
              <MoveRow item={item} editing={editing} onChange={set} />
            )}
            onAdd={() =>
              setDraft({
                ...draft,
                tm_moves: [
                  ...draft.tm_moves,
                  { employee_number: "", full_name: "", from: "", to: "" },
                ],
              })
            }
            onRemove={(i) =>
              setDraft({
                ...draft,
                tm_moves: draft.tm_moves.filter((_, idx) => idx !== i),
              })
            }
            onUpdate={(i, next) => {
              const arr = [...draft.tm_moves];
              arr[i] = next;
              setDraft({ ...draft, tm_moves: arr });
            }}
          />
        </SectionGroup>

        <Section
          number="④"
          label="任用"
          empty="（該当なし）"
          rows={data.promotions}
          editing={editing}
          renderRow={(item, set) => (
            <PromotionRow item={item} editing={editing} onChange={set} />
          )}
          onAdd={() =>
            setDraft({
              ...draft,
              promotions: [
                ...draft.promotions,
                { employee_number: "", full_name: "", from_role: "", to_role: "" },
              ],
            })
          }
          onRemove={(i) =>
            setDraft({
              ...draft,
              promotions: draft.promotions.filter((_, idx) => idx !== i),
            })
          }
          onUpdate={(i, next) => {
            const arr = [...draft.promotions];
            arr[i] = next;
            setDraft({ ...draft, promotions: arr });
          }}
        />

        {(editing || data.notes) && (
          <section className="annsec">
            <h2 className="annsec__head">備考</h2>
            {editing ? (
              <textarea
                className="field__input"
                rows={3}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                placeholder="自由記述（必要な場合）"
              />
            ) : (
              <p className="annsec__notes">{data.notes}</p>
            )}
          </section>
        )}
      </article>
    </div>
  );
}

/* ── Generic section renderer ─────────────────────────────────────── */

function SectionGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="annsec annsec--group">
      <h2 className="annsec__head">{label}</h2>
      {children}
    </section>
  );
}

type SectionProps<T> = {
  number: string;
  label: string;
  empty: string;
  rows: T[];
  editing: boolean;
  sub?: boolean;
  renderRow: (item: T, set: (next: T) => void) => React.ReactNode;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onUpdate: (idx: number, next: T) => void;
};

function Section<T>({ number, label, empty, rows, editing, sub, renderRow, onAdd, onRemove, onUpdate }: SectionProps<T>) {
  return (
    <section className={`annsec ${sub ? "annsec--sub" : ""}`}>
      <h2 className="annsec__head">
        <span className="annsec__num">{number}</span>
        {label}
        <span className="annsec__count">（{rows.length}名）</span>
      </h2>
      {rows.length === 0 ? (
        <p className="annsec__empty">{empty}</p>
      ) : (
        <ul className="annsec__list">
          {rows.map((item, i) => (
            <li key={i} className="annsec__row">
              {renderRow(item, (next) => onUpdate(i, next))}
              {editing && (
                <button
                  className="btn btn--ghost btn--xs annsec__remove no-print"
                  onClick={() => onRemove(i)}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <button className="btn btn--ghost btn--xs no-print" onClick={onAdd}>
          ＋行追加
        </button>
      )}
    </section>
  );
}

/* ── Row renderers ────────────────────────────────────────────────── */

function HireRow({
  item,
  editing,
  onChange,
}: {
  item: AnnouncementHire;
  editing: boolean;
  onChange: (next: AnnouncementHire) => void;
}) {
  if (!editing) {
    return (
      <span className="annrow">
        <strong>{item.full_name || "—"}</strong>
        <span className="annrow__sep">／</span>
        <span>{item.department ?? "—"}</span>
        <span className="annrow__sep">／</span>
        <span>{item.position_title ?? "—"}</span>
        {item.hired_at && (
          <>
            <span className="annrow__sep">／</span>
            <span className="annrow__date">{item.hired_at} 入社</span>
          </>
        )}
        {item.note && <span className="annrow__note">（{item.note}）</span>}
      </span>
    );
  }
  return (
    <span className="annrow annrow--edit">
      <input className="field__input field__input--xs" placeholder="氏名"
        value={item.full_name} onChange={(e) => onChange({ ...item, full_name: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="部署"
        value={item.department ?? ""} onChange={(e) => onChange({ ...item, department: e.target.value || null })} />
      <input className="field__input field__input--xs" placeholder="役職"
        value={item.position_title ?? ""} onChange={(e) => onChange({ ...item, position_title: e.target.value || null })} />
      <input className="field__input field__input--xs" type="date"
        value={item.hired_at ?? ""} onChange={(e) => onChange({ ...item, hired_at: e.target.value || null })} />
      <input className="field__input field__input--xs" placeholder="備考"
        value={item.note ?? ""} onChange={(e) => onChange({ ...item, note: e.target.value || undefined })} />
    </span>
  );
}

function LeaveRow({
  item,
  editing,
  onChange,
}: {
  item: AnnouncementLeave;
  editing: boolean;
  onChange: (next: AnnouncementLeave) => void;
}) {
  if (!editing) {
    return (
      <span className="annrow">
        <strong>{item.full_name || "—"}</strong>
        <span className="annrow__sep">／</span>
        <span>{item.department ?? "—"}</span>
        <span className="annrow__sep">／</span>
        <span>{item.position_title ?? "—"}</span>
        {item.left_at && (
          <>
            <span className="annrow__sep">／</span>
            <span className="annrow__date">{item.left_at} 退職</span>
          </>
        )}
        {item.note && <span className="annrow__note">（{item.note}）</span>}
      </span>
    );
  }
  return (
    <span className="annrow annrow--edit">
      <input className="field__input field__input--xs" placeholder="氏名"
        value={item.full_name} onChange={(e) => onChange({ ...item, full_name: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="部署"
        value={item.department ?? ""} onChange={(e) => onChange({ ...item, department: e.target.value || null })} />
      <input className="field__input field__input--xs" placeholder="役職"
        value={item.position_title ?? ""} onChange={(e) => onChange({ ...item, position_title: e.target.value || null })} />
      <input className="field__input field__input--xs" type="date"
        value={item.left_at ?? ""} onChange={(e) => onChange({ ...item, left_at: e.target.value || null })} />
      <input className="field__input field__input--xs" placeholder="備考"
        value={item.note ?? ""} onChange={(e) => onChange({ ...item, note: e.target.value || undefined })} />
    </span>
  );
}

function MoveRow({
  item,
  editing,
  onChange,
}: {
  item: AnnouncementMove;
  editing: boolean;
  onChange: (next: AnnouncementMove) => void;
}) {
  if (!editing) {
    return (
      <span className="annrow">
        <strong>{item.full_name || "—"}</strong>
        <span className="annrow__sep">：</span>
        <span>{item.from || "—"}</span>
        <span className="annrow__arrow">→</span>
        <span>{item.to || "—"}</span>
        {item.note && <span className="annrow__note">（{item.note}）</span>}
      </span>
    );
  }
  return (
    <span className="annrow annrow--edit">
      <input className="field__input field__input--xs" placeholder="氏名"
        value={item.full_name} onChange={(e) => onChange({ ...item, full_name: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="変更前"
        value={item.from} onChange={(e) => onChange({ ...item, from: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="変更後"
        value={item.to} onChange={(e) => onChange({ ...item, to: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="備考"
        value={item.note ?? ""} onChange={(e) => onChange({ ...item, note: e.target.value || undefined })} />
    </span>
  );
}

function PromotionRow({
  item,
  editing,
  onChange,
}: {
  item: AnnouncementPromotion;
  editing: boolean;
  onChange: (next: AnnouncementPromotion) => void;
}) {
  if (!editing) {
    return (
      <span className="annrow">
        <strong>{item.full_name || "—"}</strong>
        <span className="annrow__sep">：</span>
        <span>{item.from_role || "メンバー"}</span>
        <span className="annrow__arrow">→</span>
        <span><strong>{item.to_role || "—"}</strong></span>
        {item.note && <span className="annrow__note">（{item.note}）</span>}
      </span>
    );
  }
  return (
    <span className="annrow annrow--edit">
      <input className="field__input field__input--xs" placeholder="氏名"
        value={item.full_name} onChange={(e) => onChange({ ...item, full_name: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="変更前役職"
        value={item.from_role} onChange={(e) => onChange({ ...item, from_role: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="変更後役職"
        value={item.to_role} onChange={(e) => onChange({ ...item, to_role: e.target.value })} />
      <input className="field__input field__input--xs" placeholder="備考"
        value={item.note ?? ""} onChange={(e) => onChange({ ...item, note: e.target.value || undefined })} />
    </span>
  );
}
