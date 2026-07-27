import { useEffect, useMemo, useState } from "react";
import { useUiStore } from "../store/useUiStore";
import { useAnnouncementsStore, type AnnouncementRow } from "../store/useAnnouncementsStore";
import { useAuthStore, isOrgPowerUser } from "../store/useAuthStore";
import { useOrgStore } from "../store/useOrgStore";
import { useEmployeesStore } from "../store/useEmployeesStore";
import { employeeName } from "../lib/supabase";
import { buildAnnouncementShareUrl } from "../lib/share";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  computeHires,
  computeLeaves,
  formatDeptPath,
  formatPeriodHeading,
  moveDestinationGroup,
  previousPeriod,
  promotionKind,
  isExecutivePromotion,
  executivePromotionTitle,
  executiveRank,
  promotionRoleLabel,
  EXECUTIVE_BUCKET_LABEL,
  staffTypeOf,
  type AnnouncementHire,
  type AnnouncementLeave,
  type AnnouncementMove,
  type AnnouncementPayload,
  type AnnouncementPromotion,
  type StaffType,
} from "../lib/announcement";

/* ── Edit-mode data model ──────────────────────────────────────────────
 * While editing we keep the payload exploded into six flat lists so rows
 * can be dragged within a section and across compatible sections:
 *   hires / leaves            (self-contained)
 *   div_moves ⇄ tm_moves      (same shape — DIV間 ⇄ TM間)
 *   formal ⇄ challenge        (promotions split by kind)
 * On save they are merged back into the AnnouncementPayload shape.
 */
type EditGroup =
  | "hires"
  | "leaves"
  | "div_moves"
  | "tm_moves"
  | "formal"
  | "challenge";

type EditLists = {
  hires: AnnouncementHire[];
  leaves: AnnouncementLeave[];
  div_moves: AnnouncementMove[];
  tm_moves: AnnouncementMove[];
  formal: AnnouncementPromotion[];
  challenge: AnnouncementPromotion[];
};

const TRANSFER_TARGETS: Record<EditGroup, EditGroup[]> = {
  hires: ["hires"],
  leaves: ["leaves"],
  div_moves: ["div_moves", "tm_moves"],
  tm_moves: ["tm_moves", "div_moves"],
  formal: ["formal", "challenge"],
  challenge: ["challenge", "formal"],
};

const ROLE_OPTIONS = [
  "メンバー",
  "UL",
  "TL",
  "CTL",
  "TM",
  "CTM",
  "DM",
  "CDM",
  "CEO",
  "COO",
  "CTO",
  "CFO",
  "CHRO",
  "CRO",
  "CMO",
];

function explodePayload(p: AnnouncementPayload): EditLists {
  const promotions = p.promotions ?? [];
  return {
    hires: [...(p.hires ?? [])],
    leaves: [...(p.leaves ?? [])],
    div_moves: [...(p.div_moves ?? [])],
    tm_moves: [...(p.tm_moves ?? [])],
    formal: promotions.filter((x) => promotionKind(x) === "formal"),
    challenge: promotions.filter((x) => promotionKind(x) === "challenge"),
  };
}

function mergeLists(lists: EditLists, notes: string): AnnouncementPayload {
  return {
    hires: lists.hires,
    leaves: lists.leaves,
    div_moves: lists.div_moves,
    tm_moves: lists.tm_moves,
    promotions: [
      ...lists.formal.map((x) => ({ ...x, kind: "formal" as const })),
      ...lists.challenge.map((x) => ({ ...x, kind: "challenge" as const })),
    ],
    notes,
  };
}

export function AnnouncementDetailPage({ id }: { id: string }) {
  const navigate = useUiStore((s) => s.navigate);
  const getById = useAnnouncementsStore((s) => s.getById);
  const update = useAnnouncementsStore((s) => s.update);
  const removeOne = useAnnouncementsStore((s) => s.remove);
  const issueShareToken = useAnnouncementsStore((s) => s.issueShareToken);
  const revokeShareToken = useAnnouncementsStore((s) => s.revokeShareToken);
  const currentUser = useAuthStore((s) => s.currentUser);
  const setToast = useOrgStore((s) => s.setToast);
  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);

  const [row, setRow] = useState<AnnouncementRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [lists, setLists] = useState<EditLists | null>(null);
  const [notes, setNotes] = useState("");
  const [draftTitle, setDraftTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState(false);
  const [saving, setSaving] = useState(false);
  // Live drag source (edit mode). Not in React state per-move to avoid
  // re-rendering on every dragover — only set on start/end.
  const [drag, setDrag] = useState<{ group: EditGroup; index: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const r = await getById(id);
      if (cancelled) return;
      setRow(r);
      setDraftTitle(r?.title ?? "");
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, getById]);

  useEffect(() => {
    if (employees.length === 0) refreshEmployees();
  }, [employees.length, refreshEmployees]);

  const isAuthor = !!row && row.created_by_email === currentUser?.email;
  const canEdit = isOrgPowerUser(currentUser?.role) || isAuthor;

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}${window.location.pathname}#/announcements/${id}`;
  }, [id]);

  // Datalist sources for the edit inputs (プルダウン＋自由入力).
  const nameOptions = useMemo(() => {
    const s = new Set<string>();
    for (const e of employees) {
      const n = employeeName(e);
      if (n) s.add(n);
      if (e.full_name?.trim() && e.full_name.trim() !== n) s.add(e.full_name.trim());
    }
    return [...s].sort((a, b) => a.localeCompare(b, "ja"));
  }, [employees]);

  const deptOptions = useMemo(() => {
    const s = new Set<string>();
    for (const e of employees) {
      if (e.department?.trim()) s.add(e.department.trim());
    }
    if (row) {
      const p = row.payload;
      for (const m of [...(p.div_moves ?? []), ...(p.tm_moves ?? [])]) {
        for (const v of [m.from_div, m.from_tm, m.from_unit, m.to_div, m.to_tm, m.to_unit]) {
          if (v?.trim()) s.add(v.trim());
        }
      }
      for (const x of p.promotions ?? []) {
        for (const v of [x.div, x.tm, x.unit]) {
          if (v?.trim()) s.add(v.trim());
        }
      }
    }
    return [...s].sort((a, b) => a.localeCompare(b, "ja"));
  }, [employees, row]);

  function startEdit() {
    if (!row) return;
    setLists(explodePayload(row.payload));
    setNotes(row.payload.notes ?? "");
    setDraftTitle(row.title);
    setEditing(true);
  }

  async function saveEdit() {
    if (!row || !lists) return;
    setSaving(true);
    const payload = mergeLists(lists, notes);
    const ok = await update(row.id, { payload, title: draftTitle });
    setSaving(false);
    if (!ok) {
      const detail = useAnnouncementsStore.getState().error;
      setToast({ kind: "error", message: detail ?? "保存に失敗しました" });
      return;
    }
    setRow({ ...row, payload, title: draftTitle });
    setEditing(false);
    setToast({ kind: "info", message: "保存しました" });
  }

  function cancelEdit() {
    setLists(null);
    setEditing(false);
  }

  async function confirmDelete() {
    if (!row) return;
    setPendingDelete(false);
    const ok = await removeOne(row.id);
    if (!ok) {
      const detail = useAnnouncementsStore.getState().error;
      setToast({ kind: "error", message: detail ?? "削除に失敗しました" });
      return;
    }
    setToast({ kind: "info", message: "発令資料を削除しました" });
    navigate({ name: "announcements" });
  }

  async function copyText(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast({ kind: "info", message: okMessage });
    } catch {
      window.prompt("リンクをコピーしてください", text);
    }
  }

  async function copyShareUrl() {
    await copyText(shareUrl, "社内リンクをコピーしました（閲覧にはログインが必要）");
  }

  // ── 非ログイン共有リンク（?a=<token>）: オプトイン発行＋失効 ──────────
  async function issueOrCopyShareLink() {
    if (!row) return;
    // Already issued → just copy the existing link.
    if (row.share_token) {
      await copyText(
        buildAnnouncementShareUrl(row.share_token),
        "共有リンクをコピーしました（ログイン不要）",
      );
      return;
    }
    const token = await issueShareToken(row.id);
    if (!token) {
      const detail = useAnnouncementsStore.getState().error;
      setToast({ kind: "error", message: detail ?? "共有リンクの発行に失敗しました" });
      return;
    }
    setRow({ ...row, share_token: token });
    await copyText(
      buildAnnouncementShareUrl(token),
      "共有リンクを発行してコピーしました（ログイン不要）",
    );
  }

  async function confirmRevokeShare() {
    if (!row) return;
    setPendingRevoke(false);
    const ok = await revokeShareToken(row.id);
    if (!ok) {
      const detail = useAnnouncementsStore.getState().error;
      setToast({ kind: "error", message: detail ?? "共有リンクの無効化に失敗しました" });
      return;
    }
    setRow({ ...row, share_token: null });
    setToast({ kind: "info", message: "共有リンクを無効化しました（旧リンクは開けなくなります）" });
  }

  /* ── DnD plumbing (edit mode) ────────────────────────────────────── */

  function moveRow(to: EditGroup, toIndex: number) {
    if (!drag || !lists) return;
    const { group: from, index: fromIndex } = drag;
    if (!TRANSFER_TARGETS[from].includes(to)) return;
    const next: EditLists = { ...lists };
    const src = [...(next[from] as unknown[])];
    const [item] = src.splice(fromIndex, 1);
    if (item === undefined) return;
    if (from === to) {
      const insertAt = toIndex > fromIndex ? toIndex - 1 : toIndex;
      src.splice(insertAt, 0, item);
      (next[from] as unknown[]) = src;
    } else {
      (next[from] as unknown[]) = src;
      const dst = [...(next[to] as unknown[])];
      dst.splice(toIndex, 0, item);
      (next[to] as unknown[]) = dst;
    }
    setLists(next);
    setDrag(null);
  }

  function rowDndProps(group: EditGroup, index: number) {
    return {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.effectAllowed = "move";
        setDrag({ group, index });
      },
      onDragEnd: () => setDrag(null),
      onDragOver: (e: React.DragEvent) => {
        if (drag && TRANSFER_TARGETS[drag.group].includes(group)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        moveRow(group, index);
      },
    };
  }

  function sectionDndProps(group: EditGroup) {
    return {
      onDragOver: (e: React.DragEvent) => {
        if (drag && TRANSFER_TARGETS[drag.group].includes(group)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        if (!lists) return;
        moveRow(group, (lists[group] as unknown[]).length);
      },
    };
  }

  function setItem<G extends EditGroup>(
    group: G,
    index: number,
    next: EditLists[G][number],
  ) {
    if (!lists) return;
    const arr = [...(lists[group] as unknown[])];
    arr[index] = next;
    setLists({ ...lists, [group]: arr });
  }

  function removeItem(group: EditGroup, index: number) {
    if (!lists) return;
    const arr = [...(lists[group] as unknown[])];
    arr.splice(index, 1);
    setLists({ ...lists, [group]: arr });
  }

  function addItem(group: EditGroup) {
    if (!lists) return;
    const blank: Record<EditGroup, unknown> = {
      hires: {
        employee_number: "",
        full_name: "",
        department: null,
        position_title: null,
        hired_at: null,
      },
      leaves: {
        employee_number: "",
        full_name: "",
        department: null,
        position_title: null,
        left_at: null,
      },
      div_moves: { employee_number: "", full_name: "", from: "", to: "" },
      tm_moves: { employee_number: "", full_name: "", from: "", to: "" },
      formal: { employee_number: "", full_name: "", from_role: "", to_role: "", kind: "formal" },
      challenge: { employee_number: "", full_name: "", from_role: "", to_role: "", kind: "challenge" },
    };
    setLists({
      ...lists,
      [group]: [...(lists[group] as unknown[]), blank[group]],
    });
  }

  /* ── Render ──────────────────────────────────────────────────────── */

  if (loading) {
    return (
      <main className="page">
        <p>読み込み中…</p>
      </main>
    );
  }

  if (!row) {
    return (
      <main className="page">
        <p>発令資料が見つかりません。</p>
        <button className="btn" onClick={() => navigate({ name: "announcements" })}>
          一覧へ戻る
        </button>
      </main>
    );
  }

  const view = row.payload;
  const viewFormal = (view.promotions ?? []).filter((x) => promotionKind(x) === "formal");
  const viewChallenge = (view.promotions ?? []).filter((x) => promotionKind(x) === "challenge");

  return (
    <div className="anndetail">
      <header className="anndetail__head no-print">
        <button className="btn btn--ghost" onClick={() => navigate({ name: "announcements" })}>
          ← 一覧へ
        </button>
        <div style={{ flex: 1 }} />
        {canEdit && !editing && (
          <>
            <button className="btn" onClick={startEdit}>
              ✏️ 編集
            </button>
            <button className="btn btn--ghost" onClick={() => setPendingDelete(true)}>
              🗑 削除
            </button>
          </>
        )}
        {editing && (
          <>
            <button className="btn btn--ghost" onClick={cancelEdit}>
              キャンセル
            </button>
            <button className="btn btn--primary" onClick={saveEdit} disabled={saving}>
              {saving ? "保存中…" : "保存"}
            </button>
          </>
        )}
        <button className="btn" onClick={() => window.print()}>
          🖨 印刷
        </button>
        <button
          className="btn"
          onClick={copyShareUrl}
          title="ログインが必要な社内向けリンク（sho-san.co.jp アカウント）"
        >
          🔗 社内リンク
        </button>
        {canEdit && !editing && (
          <>
            <button
              className="btn"
              onClick={issueOrCopyShareLink}
              disabled={!row.is_published}
              title={
                row.is_published
                  ? "ログイン不要で閲覧できる共有リンク（未発行なら発行してコピー）"
                  : "公開（is_published）にすると共有リンクを発行できます"
              }
            >
              🌐 {row.share_token ? "共有リンクをコピー" : "共有リンクを発行"}
            </button>
            {row.share_token && (
              <button
                className="btn btn--ghost"
                onClick={() => setPendingRevoke(true)}
                title="現在の共有リンクを無効化します（配布済みリンクは開けなくなります）"
              >
                🚫 リンク無効化
              </button>
            )}
          </>
        )}
      </header>

      {editing && (
        <p className="anndetail__editHint no-print">
          行は <span className="anndetail__grip">⠿</span> をドラッグで並べ替え・別セクションへ移動できます
          （DIV間 ⇄ TM間、正式任用 ⇄ チャレンジ任用）。各項目は候補から選ぶか自由入力できます。
        </p>
      )}

      {/* Shared datalists for edit inputs */}
      {editing && (
        <>
          <datalist id="ann-names">
            {nameOptions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <datalist id="ann-depts">
            {deptOptions.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          <datalist id="ann-roles">
            {ROLE_OPTIONS.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </>
      )}

      <article className="anndetail__paper">
        <header className="anndetail__paperHead">
          <p className="anndetail__period">{formatPeriodHeading(row.period)}</p>
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

        {/* ① 入社 */}
        <section className="annsec" {...(editing ? sectionDndProps("hires") : {})}>
          <SectionHead
            number="①"
            label="入社"
            count={(editing ? lists!.hires : view.hires).length}
            caption={`従業員マスターの ${formatPeriodHeading(row.period)} 入社メンバー`}
            editing={editing}
            onRefill={
              editing
                ? () => {
                    setLists({ ...lists!, hires: computeHires(employees, row.period) });
                    setToast({ kind: "info", message: "従業員マスターから入社者を再取得しました" });
                  }
                : undefined
            }
          />
          <PeopleRows
            group="hires"
            rows={editing ? lists!.hires : view.hires}
            editing={editing}
            dateKey="hired_at"
            dateSuffix="入社"
            rowDndProps={rowDndProps}
            onChange={(i, next) => setItem("hires", i, next as AnnouncementHire)}
            onRemove={(i) => removeItem("hires", i)}
            onAdd={() => addItem("hires")}
          />
        </section>

        {/* ② 退職 */}
        <section className="annsec" {...(editing ? sectionDndProps("leaves") : {})}>
          <SectionHead
            number="②"
            label="退職"
            count={(editing ? lists!.leaves : view.leaves).length}
            caption={`従業員マスターの ${formatPeriodHeading(previousPeriod(row.period))}（前月）退職メンバー`}
            editing={editing}
            onRefill={
              editing
                ? () => {
                    setLists({ ...lists!, leaves: computeLeaves(employees, row.period) });
                    setToast({ kind: "info", message: "従業員マスターから退職者（前月分）を再取得しました" });
                  }
                : undefined
            }
          />
          <PeopleRows
            group="leaves"
            rows={editing ? lists!.leaves : view.leaves}
            editing={editing}
            dateKey="left_at"
            dateSuffix="退職"
            rowDndProps={rowDndProps}
            onChange={(i, next) => setItem("leaves", i, next as AnnouncementLeave)}
            onRemove={(i) => removeItem("leaves", i)}
            onAdd={() => addItem("leaves")}
          />
        </section>

        {/* ③ 人事異動 */}
        <section className="annsec annsec--group">
          <h2 className="annsec__head">
            <span className="annsec__num">③</span>
            人事異動
          </h2>

          <section className="annsec annsec--sub" {...(editing ? sectionDndProps("div_moves") : {})}>
            <SectionHead
              number="A."
              label="DIV間の異動"
              count={(editing ? lists!.div_moves : view.div_moves).length}
              editing={editing}
            />
            <MoveRows
              group="div_moves"
              rows={editing ? lists!.div_moves : view.div_moves}
              editing={editing}
              groupKind="div"
              rowDndProps={rowDndProps}
              onChange={(i, next) => setItem("div_moves", i, next)}
              onRemove={(i) => removeItem("div_moves", i)}
              onAdd={() => addItem("div_moves")}
            />
          </section>

          <section className="annsec annsec--sub" {...(editing ? sectionDndProps("tm_moves") : {})}>
            <SectionHead
              number="B."
              label="TM間の異動"
              count={(editing ? lists!.tm_moves : view.tm_moves).length}
              editing={editing}
            />
            <MoveRows
              group="tm_moves"
              rows={editing ? lists!.tm_moves : view.tm_moves}
              editing={editing}
              groupKind="tm"
              rowDndProps={rowDndProps}
              onChange={(i, next) => setItem("tm_moves", i, next)}
              onRemove={(i) => removeItem("tm_moves", i)}
              onAdd={() => addItem("tm_moves")}
            />
          </section>
        </section>

        {/* ④ 任用 — 正式が上位概念なので先＆強調、チャレンジは差別化 */}
        <section className="annsec annsec--group">
          <h2 className="annsec__head">
            <span className="annsec__num">④</span>
            任用
          </h2>

          <section
            className="annsec annsec--sub annsec--formal"
            {...(editing ? sectionDndProps("formal") : {})}
          >
            <SectionHead
              number="A."
              label="正式任用"
              badge="等級を伴う正式な任用"
              count={(editing ? lists!.formal : viewFormal).length}
              editing={editing}
            />
            <PromotionRows
              group="formal"
              rows={editing ? lists!.formal : viewFormal}
              editing={editing}
              rowDndProps={rowDndProps}
              onChange={(i, next) => setItem("formal", i, next)}
              onRemove={(i) => removeItem("formal", i)}
              onAdd={() => addItem("formal")}
              onKindChange={(i) => {
                // 正式 → チャレンジへ付け替え
                if (!lists) return;
                const item = { ...lists.formal[i], kind: "challenge" as const };
                const formal = lists.formal.filter((_, idx) => idx !== i);
                setLists({ ...lists, formal, challenge: [...lists.challenge, item] });
              }}
              kindLabel="正式"
              otherKindLabel="チャレンジへ移動"
            />
          </section>

          <section
            className="annsec annsec--sub annsec--challenge"
            {...(editing ? sectionDndProps("challenge") : {})}
          >
            <SectionHead
              number="B."
              label="チャレンジ任用"
              badge="役割先行のチャレンジ任用（C任用）"
              count={(editing ? lists!.challenge : viewChallenge).length}
              editing={editing}
            />
            <PromotionRows
              group="challenge"
              rows={editing ? lists!.challenge : viewChallenge}
              editing={editing}
              rowDndProps={rowDndProps}
              onChange={(i, next) => setItem("challenge", i, next)}
              onRemove={(i) => removeItem("challenge", i)}
              onAdd={() => addItem("challenge")}
              onKindChange={(i) => {
                if (!lists) return;
                const item = { ...lists.challenge[i], kind: "formal" as const };
                const challenge = lists.challenge.filter((_, idx) => idx !== i);
                setLists({ ...lists, challenge, formal: [...lists.formal, item] });
              }}
              kindLabel="チャレンジ"
              otherKindLabel="正式へ移動"
            />
          </section>
        </section>

        {(editing || view.notes) && (
          <section className="annsec">
            <h2 className="annsec__head">備考</h2>
            {editing ? (
              <textarea
                className="field__input"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="自由記述（必要な場合）"
              />
            ) : (
              <p className="annsec__notes">{view.notes}</p>
            )}
          </section>
        )}
      </article>

      {pendingDelete && (
        <ConfirmDialog
          title="発令資料の削除"
          message={
            <>
              「{row.title}」（{formatPeriodHeading(row.period)}）を削除します。この操作は元に戻せません。よろしいですか？
            </>
          }
          confirmLabel="削除する"
          variant="danger"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(false)}
        />
      )}

      {pendingRevoke && (
        <ConfirmDialog
          title="共有リンクの無効化"
          message={
            <>
              現在の共有リンク（ログイン不要）を無効化します。すでに配布したリンクは開けなくなります。
              必要なら後で「共有リンクを発行」で新しいリンクを作り直せます。よろしいですか？
            </>
          }
          confirmLabel="無効化する"
          variant="danger"
          onConfirm={confirmRevokeShare}
          onCancel={() => setPendingRevoke(false)}
        />
      )}
    </div>
  );
}

/* ── Read-only paper (shared by the detail page's view mode and the
 *    anonymous share view). Renders the same sections as the editor's
 *    view path via the same sub-components + CSS classes, so the layout
 *    stays identical. Edit affordances are omitted. ────────────────── */
export function AnnouncementPaper({ row }: { row: AnnouncementRow }) {
  const view = row.payload;
  const viewFormal = (view.promotions ?? []).filter((x) => promotionKind(x) === "formal");
  const viewChallenge = (view.promotions ?? []).filter(
    (x) => promotionKind(x) === "challenge",
  );
  const noop = () => {};
  const noDnd = () => ({});
  return (
    <article className="anndetail__paper">
      <header className="anndetail__paperHead">
        <p className="anndetail__period">{formatPeriodHeading(row.period)}</p>
        <h1 className="anndetail__title">{row.title}</h1>
      </header>

      <section className="annsec">
        <SectionHead
          number="①"
          label="入社"
          count={(view.hires ?? []).length}
          caption={`従業員マスターの ${formatPeriodHeading(row.period)} 入社メンバー`}
          editing={false}
        />
        <PeopleRows
          group="hires"
          rows={view.hires ?? []}
          editing={false}
          dateKey="hired_at"
          dateSuffix="入社"
          rowDndProps={noDnd}
          onChange={noop}
          onRemove={noop}
          onAdd={noop}
        />
      </section>

      <section className="annsec">
        <SectionHead
          number="②"
          label="退職"
          count={(view.leaves ?? []).length}
          caption={`従業員マスターの ${formatPeriodHeading(previousPeriod(row.period))}（前月）退職メンバー`}
          editing={false}
        />
        <PeopleRows
          group="leaves"
          rows={view.leaves ?? []}
          editing={false}
          dateKey="left_at"
          dateSuffix="退職"
          rowDndProps={noDnd}
          onChange={noop}
          onRemove={noop}
          onAdd={noop}
        />
      </section>

      <section className="annsec annsec--group">
        <h2 className="annsec__head">
          <span className="annsec__num">③</span>
          人事異動
        </h2>
        <section className="annsec annsec--sub">
          <SectionHead number="A." label="DIV間の異動" count={(view.div_moves ?? []).length} editing={false} />
          <MoveRows
            group="div_moves"
            rows={view.div_moves ?? []}
            editing={false}
            groupKind="div"
            rowDndProps={noDnd}
            onChange={noop}
            onRemove={noop}
            onAdd={noop}
          />
        </section>
        <section className="annsec annsec--sub">
          <SectionHead number="B." label="TM間の異動" count={(view.tm_moves ?? []).length} editing={false} />
          <MoveRows
            group="tm_moves"
            rows={view.tm_moves ?? []}
            editing={false}
            groupKind="tm"
            rowDndProps={noDnd}
            onChange={noop}
            onRemove={noop}
            onAdd={noop}
          />
        </section>
      </section>

      <section className="annsec annsec--group">
        <h2 className="annsec__head">
          <span className="annsec__num">④</span>
          任用
        </h2>
        <section className="annsec annsec--sub annsec--formal">
          <SectionHead number="A." label="正式任用" badge="等級を伴う正式な任用" count={viewFormal.length} editing={false} />
          <PromotionRows
            group="formal"
            rows={viewFormal}
            editing={false}
            rowDndProps={noDnd}
            onChange={noop}
            onRemove={noop}
            onAdd={noop}
            onKindChange={noop}
            kindLabel="正式"
            otherKindLabel=""
          />
        </section>
        <section className="annsec annsec--sub annsec--challenge">
          <SectionHead number="B." label="チャレンジ任用" badge="役割先行のチャレンジ任用（C任用）" count={viewChallenge.length} editing={false} />
          <PromotionRows
            group="challenge"
            rows={viewChallenge}
            editing={false}
            rowDndProps={noDnd}
            onChange={noop}
            onRemove={noop}
            onAdd={noop}
            onKindChange={noop}
            kindLabel="チャレンジ"
            otherKindLabel=""
          />
        </section>
      </section>

      {view.notes && (
        <section className="annsec">
          <h2 className="annsec__head">備考</h2>
          <p className="annsec__notes">{view.notes}</p>
        </section>
      )}
    </article>
  );
}

/* ── Section chrome ───────────────────────────────────────────────── */

function SectionHead({
  number,
  label,
  count,
  caption,
  badge,
  editing,
  onRefill,
}: {
  number: string;
  label: string;
  count: number;
  caption?: string;
  badge?: string;
  editing: boolean;
  onRefill?: () => void;
}) {
  return (
    <>
      <h2 className="annsec__head">
        <span className="annsec__num">{number}</span>
        {label}
        {badge && <span className="annsec__badge">{badge}</span>}
        <span className="annsec__count">（{count}名）</span>
        {editing && onRefill && (
          <button
            className="btn btn--ghost btn--xs no-print annsec__refill"
            onClick={onRefill}
            title="従業員マスターから対象期間の該当者を取り直します（現在の行は置き換わります）"
          >
            ⟳ マスターから再取得
          </button>
        )}
      </h2>
      {caption && <p className="annsec__caption">{caption}</p>}
    </>
  );
}

type RowDndProps = (
  group: EditGroup,
  index: number,
) => Record<string, unknown>;

function Grip() {
  return (
    <span className="anndetail__grip no-print" title="ドラッグで並べ替え / 移動" aria-hidden>
      ⠿
    </span>
  );
}

/* ── ①② 入社・退職 ────────────────────────────────────────────────── */

function PeopleRows<T extends AnnouncementHire | AnnouncementLeave>({
  group,
  rows,
  editing,
  dateKey,
  dateSuffix,
  rowDndProps,
  onChange,
  onRemove,
  onAdd,
}: {
  group: EditGroup;
  rows: T[];
  editing: boolean;
  dateKey: "hired_at" | "left_at";
  dateSuffix: string;
  rowDndProps: RowDndProps;
  onChange: (i: number, next: T) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  const dateOf = (item: T) =>
    (item as Record<string, string | null>)[dateKey] ?? null;

  // ── View mode: split into 社員 / インターン with an H3 sub-heading each ──
  if (!editing) {
    if (rows.length === 0) return <p className="annsec__empty">（該当なし）</p>;
    const order: StaffType[] = ["社員", "インターン"];
    const groups = order
      .map((label) => [label, rows.filter((r) => staffTypeOf(r) === label)] as const)
      .filter(([, list]) => list.length > 0);
    return (
      <div className="annstaff">
        {groups.map(([label, list]) => (
          <div key={label} className="annstaff__grp">
            <h3 className="annstaff__head">
              {label}
              <span className="annstaff__count">{list.length}名</span>
            </h3>
            <ul className="annsec__list">
              {list.map((item, i) => {
                const dateVal = dateOf(item);
                return (
                  <li key={i} className="annsec__row">
                    <span className="annrow">
                      <strong>{item.full_name || "—"}</strong>
                      <span className="annrow__sep">／</span>
                      <span>{item.department ?? "—"}</span>
                      {item.concurrent && (
                        <span className="annrow__kenmu">
                          兼務：{item.concurrent}
                        </span>
                      )}
                      {item.position_title && (
                        <>
                          <span className="annrow__sep">／</span>
                          <span>{item.position_title}</span>
                        </>
                      )}
                      {dateVal && (
                        <>
                          <span className="annrow__sep">／</span>
                          <span className="annrow__date">
                            {dateVal} {dateSuffix}
                          </span>
                        </>
                      )}
                      {item.note && (
                        <span className="annrow__note">（{item.note}）</span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    );
  }

  // ── Edit mode: flat list (drag/reorder across staff types stays possible) ──
  return (
    <>
      <ul className="annsec__list">
        {rows.map((item, i) => {
          const dateVal = dateOf(item);
          return (
            <li key={i} className="annsec__row annsec__row--edit" {...rowDndProps(group, i)}>
              <Grip />
              <span className="annrow annrow--edit">
                <input
                  className="field__input field__input--xs"
                  placeholder="氏名"
                  list="ann-names"
                  value={item.full_name}
                  onChange={(e) => onChange(i, { ...item, full_name: e.target.value })}
                />
                <select
                  className="field__input field__input--xs"
                  value={staffTypeOf(item)}
                  onChange={(e) =>
                    onChange(i, { ...item, staff_type: e.target.value as StaffType })
                  }
                  title="社員 / インターン"
                >
                  <option value="社員">社員</option>
                  <option value="インターン">インターン</option>
                </select>
                <input
                  className="field__input field__input--xs"
                  placeholder="主務（所属）"
                  list="ann-depts"
                  value={item.department ?? ""}
                  onChange={(e) => onChange(i, { ...item, department: e.target.value || null })}
                />
                <input
                  className="field__input field__input--xs"
                  placeholder="兼務（正式名称／複数は「／」区切り）"
                  list="ann-depts"
                  value={item.concurrent ?? ""}
                  onChange={(e) =>
                    onChange(i, { ...item, concurrent: e.target.value || null })
                  }
                />
                <input
                  className="field__input field__input--xs"
                  placeholder="役職"
                  list="ann-roles"
                  value={item.position_title ?? ""}
                  onChange={(e) =>
                    onChange(i, { ...item, position_title: e.target.value || null })
                  }
                />
                <input
                  className="field__input field__input--xs"
                  type="date"
                  value={dateVal ?? ""}
                  onChange={(e) =>
                    onChange(i, { ...item, [dateKey]: e.target.value || null } as T)
                  }
                />
                <input
                  className="field__input field__input--xs"
                  placeholder="備考"
                  value={item.note ?? ""}
                  onChange={(e) => onChange(i, { ...item, note: e.target.value || undefined })}
                />
              </span>
              <button
                className="btn btn--ghost btn--xs annsec__remove no-print"
                onClick={() => onRemove(i)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      {editing && (
        <button className="btn btn--ghost btn--xs no-print" onClick={onAdd}>
          ＋行追加
        </button>
      )}
    </>
  );
}

/* ── ③ 異動 ──────────────────────────────────────────────────────── */

function MoveRows({
  group,
  rows,
  editing,
  groupKind,
  rowDndProps,
  onChange,
  onRemove,
  onAdd,
}: {
  group: EditGroup;
  rows: AnnouncementMove[];
  editing: boolean;
  groupKind: "div" | "tm";
  rowDndProps: RowDndProps;
  onChange: (i: number, next: AnnouncementMove) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  if (!editing) {
    if (rows.length === 0) return <p className="annsec__empty">（該当なし）</p>;
    // View: bucket by destination so long lists read as「受け入れ先ごと」
    const buckets = new Map<string, { item: AnnouncementMove; idx: number }[]>();
    rows.forEach((item, idx) => {
      const k = moveDestinationGroup(item, groupKind) || "（未指定）";
      const arr = buckets.get(k) ?? [];
      arr.push({ item, idx });
      buckets.set(k, arr);
    });
    return (
      <div className="anngrp anngrp--stack">
        {[...buckets.entries()].map(([key, items]) => (
          <div key={key} className="anngrp__bucket">
            <h3 className="anngrp__head">
              <span className="anngrp__dest">{key}</span>
              <span className="anngrp__count">{items.length}名</span>
            </h3>
            <table className="annmoves annmoves--cols">
              <thead>
                <tr>
                  <th className="annmoves__name">対象者</th>
                  <th className="annmoves__from">旧所属</th>
                  <th className="annmoves__sep" aria-hidden></th>
                  <th className="annmoves__to">新所属</th>
                </tr>
              </thead>
              <tbody>
                {items.map(({ item, idx }) => {
                  const fromPath =
                    formatDeptPath(item.from_div, item.from_tm, item.from_unit) ??
                    item.from ??
                    "—";
                  const toPath =
                    formatDeptPath(item.to_div, item.to_tm, item.to_unit) ?? item.to ?? "—";
                  return (
                    <tr key={idx}>
                      <td className="annmoves__name">{item.full_name || "—"}</td>
                      <td className="annmoves__from">{fromPath}</td>
                      <td className="annmoves__sep" aria-hidden>
                        →
                      </td>
                      <td className="annmoves__to">
                        <strong>{toPath}</strong>
                        {item.note && (
                          <span className="annmoves__inlnote">（{item.note}）</span>
                        )}
                        {item.to_concurrent && (
                          <span className="annmoves__kenmu">
                            兼務：{item.to_concurrent}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <ul className="annsec__list">
        {rows.map((item, i) => (
          <li key={i} className="annsec__row annsec__row--edit" {...rowDndProps(group, i)}>
            <Grip />
            <span className="annrow annrow--edit">
              <input
                className="field__input field__input--xs"
                placeholder="氏名"
                list="ann-names"
                value={item.full_name}
                onChange={(e) => onChange(i, { ...item, full_name: e.target.value })}
              />
              <span className="annrow__editLabel">変更前</span>
              <input
                className="field__input field__input--xs"
                placeholder="DIV"
                list="ann-depts"
                value={item.from_div ?? ""}
                onChange={(e) => onChange(i, { ...item, from_div: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="TM"
                list="ann-depts"
                value={item.from_tm ?? ""}
                onChange={(e) => onChange(i, { ...item, from_tm: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="Unit"
                list="ann-depts"
                value={item.from_unit ?? ""}
                onChange={(e) => onChange(i, { ...item, from_unit: e.target.value || null })}
              />
              <span className="annrow__arrow">→</span>
              <span className="annrow__editLabel">変更後</span>
              <input
                className="field__input field__input--xs"
                placeholder="DIV"
                list="ann-depts"
                value={item.to_div ?? ""}
                onChange={(e) => onChange(i, { ...item, to_div: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="TM"
                list="ann-depts"
                value={item.to_tm ?? ""}
                onChange={(e) => onChange(i, { ...item, to_tm: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="Unit"
                list="ann-depts"
                value={item.to_unit ?? ""}
                onChange={(e) => onChange(i, { ...item, to_unit: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="新所属の兼務（正式名称／「／」区切り）"
                list="ann-depts"
                value={item.to_concurrent ?? ""}
                onChange={(e) =>
                  onChange(i, { ...item, to_concurrent: e.target.value || null })
                }
              />
              <input
                className="field__input field__input--xs"
                placeholder="備考"
                value={item.note ?? ""}
                onChange={(e) => onChange(i, { ...item, note: e.target.value || undefined })}
              />
            </span>
            <button
              className="btn btn--ghost btn--xs annsec__remove no-print"
              onClick={() => onRemove(i)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn--ghost btn--xs no-print" onClick={onAdd}>
        ＋行追加
      </button>
    </>
  );
}

/* ── ④ 任用 ──────────────────────────────────────────────────────── */

function PromotionRows({
  group,
  rows,
  editing,
  rowDndProps,
  onChange,
  onRemove,
  onAdd,
  onKindChange,
  kindLabel,
  otherKindLabel,
}: {
  group: EditGroup;
  rows: AnnouncementPromotion[];
  editing: boolean;
  rowDndProps: RowDndProps;
  onChange: (i: number, next: AnnouncementPromotion) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
  onKindChange: (i: number) => void;
  kindLabel: string;
  otherKindLabel: string;
}) {
  if (!editing) {
    if (rows.length === 0) return <p className="annsec__empty">（該当なし）</p>;
    // 役員（執行役員）任用は「役員登用」バケットに集約し、それ以外は DIV
    // （無ければ TM）でバケットする。役員登用は先頭に表示する。
    const buckets = new Map<string, { item: AnnouncementPromotion; idx: number }[]>();
    rows.forEach((item, idx) => {
      const k = isExecutivePromotion(item)
        ? EXECUTIVE_BUCKET_LABEL
        : item.div?.trim() || item.tm?.trim() || "（部署不明）";
      const arr = buckets.get(k) ?? [];
      arr.push({ item, idx });
      buckets.set(k, arr);
    });
    // 役員登用を常に先頭へ。役員バケット内は役職序列（CEO→COO→CTO…）で並べる。
    const entries = [...buckets.entries()].sort((a, b) => {
      if (a[0] === EXECUTIVE_BUCKET_LABEL) return -1;
      if (b[0] === EXECUTIVE_BUCKET_LABEL) return 1;
      return 0;
    });
    const execBucket = buckets.get(EXECUTIVE_BUCKET_LABEL);
    if (execBucket) {
      execBucket.sort((x, y) => executiveRank(x.item) - executiveRank(y.item));
    }
    return (
      <div className="anngrp anngrp--compact">
        {entries.map(([key, items]) => (
          <div key={key} className="anngrp__bucket">
            <h3 className="anngrp__head">
              <span className="anngrp__dest">{key}</span>
              <span className="anngrp__count">{items.length}名</span>
            </h3>
            <table className="annmoves">
              <tbody>
                {items.map(({ item, idx }) => {
                  const isExec = isExecutivePromotion(item);
                  // 役員登用は部署プレフィックスを付けず「◯◯ 執行役員COO（事業
                  // 統括）に就任」の一律表記にする。
                  const path = isExec
                    ? null
                    : formatDeptPath(item.div, item.tm, item.unit);
                  const hasBefore =
                    !isExec && !!(item.from_role && item.from_role.trim());
                  const toDisplay = isExec
                    ? executivePromotionTitle(item)
                    : promotionRoleLabel(item.to_role) || "—";
                  return (
                    <tr key={idx}>
                      <td className="annmoves__name">{item.full_name || "—"}</td>
                      <td className="annmoves__to">
                        {path && (
                          <span className="annmoves__deptPath">{path}</span>
                        )}
                        {hasBefore ? (
                          <>
                            <span>{promotionRoleLabel(item.from_role)}</span>
                            <span className="annrow__arrow">→</span>
                            <strong className="annmoves__toRole">
                              {toDisplay}
                            </strong>
                          </>
                        ) : (
                          <>
                            <strong className="annmoves__toRole">
                              {toDisplay}
                            </strong>
                            <span className="annmoves__appoint">に就任</span>
                          </>
                        )}
                        {item.note && (
                          <span className="annmoves__inlnote">（{item.note}）</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <ul className="annsec__list">
        {rows.map((item, i) => (
          <li key={i} className="annsec__row annsec__row--edit" {...rowDndProps(group, i)}>
            <Grip />
            <span className="annrow annrow--edit">
              <input
                className="field__input field__input--xs"
                placeholder="氏名"
                list="ann-names"
                value={item.full_name}
                onChange={(e) => onChange(i, { ...item, full_name: e.target.value })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="DIV"
                list="ann-depts"
                value={item.div ?? ""}
                onChange={(e) => onChange(i, { ...item, div: e.target.value || null })}
              />
              <input
                className="field__input field__input--xs"
                placeholder="TM"
                list="ann-depts"
                value={item.tm ?? ""}
                onChange={(e) => onChange(i, { ...item, tm: e.target.value || null })}
              />
              <select
                className="field__input field__input--xs"
                value={item.from_role}
                onChange={(e) => onChange(i, { ...item, from_role: e.target.value })}
                title="変更前役職"
              >
                <option value="">変更前役職</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
                {item.from_role && !ROLE_OPTIONS.includes(item.from_role) && (
                  <option value={item.from_role}>{item.from_role}</option>
                )}
              </select>
              <span className="annrow__arrow">→</span>
              <select
                className="field__input field__input--xs"
                value={item.to_role}
                onChange={(e) => onChange(i, { ...item, to_role: e.target.value })}
                title="変更後役職"
              >
                <option value="">変更後役職</option>
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
                {item.to_role && !ROLE_OPTIONS.includes(item.to_role) && (
                  <option value={item.to_role}>{item.to_role}</option>
                )}
              </select>
              <input
                className="field__input field__input--xs"
                placeholder="備考"
                value={item.note ?? ""}
                onChange={(e) => onChange(i, { ...item, note: e.target.value || undefined })}
              />
              <button
                className="btn btn--ghost btn--xs no-print"
                onClick={() => onKindChange(i)}
                title={`この行を${otherKindLabel}`}
              >
                ⇄ {otherKindLabel}
              </button>
            </span>
            <button
              className="btn btn--ghost btn--xs annsec__remove no-print"
              onClick={() => onRemove(i)}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      <button className="btn btn--ghost btn--xs no-print" onClick={onAdd}>
        ＋{kindLabel}任用の行追加
      </button>
    </>
  );
}
