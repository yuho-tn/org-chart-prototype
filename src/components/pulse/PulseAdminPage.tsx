import { useEffect, useState } from "react";
import { usePulseAdminStore } from "../../store/usePulseAdminStore";
import { PulseSubnav } from "./PulseSubnav";
import {
  periodLabel,
  QUESTION_TYPE_LABEL,
  SET_STATUS_LABEL,
  CYCLE_STATUS_LABEL,
  type PulseQuestionSetRow,
  type PulseQuestionRow,
  type PulseQuestionType,
} from "../../lib/pulse";

/**
 * パルスサーベイ 設定（#/pulse/admin）。質問セット＋設問＋配信サイクルの管理。
 * すべて admin 直書き（0021 の RLS＋不可変ガード）。
 * draft セットのみ設問編集可、active 化で凍結、クローンで新バージョン。
 * サイクルは scheduled→sent（受付開始）→closed。実際の配信通知はスライス7。
 */
export function PulseAdminPage() {
  const { loaded, loading, error, load } = usePulseAdminStore();
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page pdash">
      <header className="pdash__head">
        <div>
          <h1 className="pdash__title">パルスサーベイ 設定</h1>
          <p className="pdash__sub">質問セットのバージョン管理と配信サイクルの作成（下書きのみ編集可）</p>
        </div>
      </header>

      <PulseSubnav active="admin" />

      {!loaded && loading && <p className="pdash__muted">読み込み中…</p>}
      {loaded && error && <p className="pdash__error">{error}</p>}

      {loaded && !error && (
        <>
          <QuestionSets onToast={setToast} />
          <Cycles onToast={setToast} />
        </>
      )}

      {toast && (
        <div className="pdash__toast" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </main>
  );
}

function QuestionSets({ onToast }: { onToast: (m: string) => void }) {
  const { sets, createSet, busy } = usePulseAdminStore();
  const [name, setName] = useState("");

  const onCreate = async () => {
    const res = await createSet(name);
    onToast(res.ok ? "下書きセットを作成しました" : res.reason ?? "作成に失敗しました");
    if (res.ok) setName("");
  };

  return (
    <section className="padm__section">
      <h2 className="pdash__h2">質問セット</h2>
      <div className="padm__newrow">
        <input
          className="padm__input"
          placeholder="新しいセット名（例：月次パルス）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button className="pdash__btn pdash__btn--primary" onClick={onCreate} disabled={busy || !name.trim()}>
          下書きを作成
        </button>
      </div>

      {sets.length === 0 && <p className="pdash__muted">質問セットがありません。</p>}
      <div className="padm__setlist">
        {sets.map((s) => (
          <SetCard key={s.id} set={s} onToast={onToast} />
        ))}
      </div>
    </section>
  );
}

function SetCard({ set: s, onToast }: { set: PulseQuestionSetRow; onToast: (m: string) => void }) {
  const { questionsBySet, activateSet, archiveSet, deleteSet, cloneSet, renameSet, busy } =
    usePulseAdminStore();
  const questions = questionsBySet[s.id] ?? [];
  const isDraft = s.status === "draft";
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);

  const run = (label: string) => async (p: Promise<{ ok: boolean; reason?: string }>) => {
    const res = await p;
    onToast(res.ok ? label : res.reason ?? "操作に失敗しました");
  };

  const onActivate = async () => {
    if (questions.length === 0) {
      onToast("設問が0件です。1問以上追加してください");
      return;
    }
    if (!confirm(`「${s.name} v${s.version}」を有効化します。有効化後は設問を編集できません。よろしいですか？`)) return;
    run("有効化しました")(activateSet(s.id));
  };

  return (
    <div className={"padm__setcard padm__setcard--" + s.status}>
      <div className="padm__sethead">
        <div className="padm__setname">
          {renaming ? (
            <span className="padm__renamerow">
              <input className="padm__input" value={name} onChange={(e) => setName(e.target.value)} />
              <button
                className="pdash__btn"
                disabled={busy}
                onClick={async () => {
                  await run("名称を更新しました")(renameSet(s.id, name));
                  setRenaming(false);
                }}
              >
                保存
              </button>
              <button className="pdash__btn" onClick={() => { setRenaming(false); setName(s.name); }}>
                取消
              </button>
            </span>
          ) : (
            <>
              <span className="padm__settitle">{s.name}</span>
              <span className="padm__ver">v{s.version}</span>
              <span className={`padm__badge padm__badge--${s.status}`}>{SET_STATUS_LABEL[s.status]}</span>
              <span className="padm__count">設問 {questions.length}</span>
            </>
          )}
        </div>
        <div className="padm__setactions">
          {isDraft && (
            <>
              <button className="pdash__btn" disabled={busy} onClick={() => setRenaming(true)}>
                改名
              </button>
              <button className="pdash__btn pdash__btn--primary" disabled={busy} onClick={onActivate}>
                有効化
              </button>
              <button
                className="pdash__btn padm__btn--danger"
                disabled={busy}
                onClick={() => {
                  if (confirm("この下書きセットを削除しますか？（設問も削除されます）")) run("削除しました")(deleteSet(s.id));
                }}
              >
                削除
              </button>
            </>
          )}
          {s.status === "active" && (
            <button
              className="pdash__btn"
              disabled={busy}
              onClick={() => {
                if (confirm("このセットをアーカイブしますか？")) run("アーカイブしました")(archiveSet(s.id));
              }}
            >
              アーカイブ
            </button>
          )}
          <button className="pdash__btn" disabled={busy} onClick={() => run("新バージョンを作成しました（下書き）")(cloneSet(s.id))}>
            複製して新版
          </button>
        </div>
      </div>

      {isDraft ? (
        <QuestionEditor setId={s.id} questions={questions} onToast={onToast} />
      ) : (
        <ol className="padm__qview">
          {questions.map((q) => (
            <li key={q.id} className="padm__qviewitem">
              <span className="padm__qcat">{q.category || "—"}</span>
              <span className="padm__qlabel">{q.label}</span>
              <span className="padm__qtype">{QUESTION_TYPE_LABEL[q.type]}</span>
            </li>
          ))}
          {questions.length === 0 && <li className="pdash__muted">設問なし</li>}
        </ol>
      )}
    </div>
  );
}

function QuestionEditor({
  setId,
  questions,
  onToast,
}: {
  setId: string;
  questions: PulseQuestionRow[];
  onToast: (m: string) => void;
}) {
  const { addQuestion, updateQuestion, deleteQuestion, moveQuestion, busy } = usePulseAdminStore();
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("");
  const [type, setType] = useState<PulseQuestionType>("weather5");

  const onAdd = async () => {
    const res = await addQuestion(setId, { label, category: category || null, type });
    onToast(res.ok ? "設問を追加しました" : res.reason ?? "追加に失敗しました");
    if (res.ok) {
      setLabel("");
      setCategory("");
    }
  };

  return (
    <div className="padm__qeditor">
      <ol className="padm__qlist">
        {questions.map((q, i) => (
          <QRow
            key={q.id}
            q={q}
            first={i === 0}
            last={i === questions.length - 1}
            busy={busy}
            onMove={(dir) => moveQuestion(setId, q.id, dir)}
            onSave={(patch) => updateQuestion(q.id, patch)}
            onDelete={() => deleteQuestion(q.id)}
          />
        ))}
      </ol>

      <div className="padm__qadd">
        <input
          className="padm__input padm__input--cat"
          placeholder="分類（任意）"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <input
          className="padm__input"
          placeholder="設問文（例：最近の仕事の充実度は？）"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <select className="padm__input padm__input--type" value={type} onChange={(e) => setType(e.target.value as PulseQuestionType)}>
          {(["weather5", "scale", "free_text"] as PulseQuestionType[]).map((t) => (
            <option key={t} value={t}>{QUESTION_TYPE_LABEL[t]}</option>
          ))}
        </select>
        <button className="pdash__btn pdash__btn--primary" disabled={busy || !label.trim()} onClick={onAdd}>
          追加
        </button>
      </div>
    </div>
  );
}

/** 設問1行。テキストはローカル state で編集し、onBlur で変更時のみ保存（毎キー打鍵の書込み回避）。 */
function QRow({
  q,
  first,
  last,
  busy,
  onMove,
  onSave,
  onDelete,
}: {
  q: PulseQuestionRow;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (dir: -1 | 1) => void;
  onSave: (patch: Partial<Pick<PulseQuestionRow, "label" | "category" | "type">>) => void;
  onDelete: () => void;
}) {
  const [label, setLabel] = useState(q.label);
  const [category, setCategory] = useState(q.category ?? "");

  return (
    <li className="padm__qrow">
      <div className="padm__qmove">
        <button className="padm__iconbtn" disabled={busy || first} onClick={() => onMove(-1)} title="上へ">▲</button>
        <button className="padm__iconbtn" disabled={busy || last} onClick={() => onMove(1)} title="下へ">▼</button>
      </div>
      <input
        className="padm__input padm__input--cat"
        value={category}
        placeholder="分類"
        onChange={(e) => setCategory(e.target.value)}
        onBlur={() => {
          const v = category.trim() || null;
          if (v !== (q.category ?? null)) onSave({ category: v });
        }}
      />
      <input
        className="padm__input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={() => {
          const v = label.trim();
          if (v && v !== q.label) onSave({ label: v });
          else if (!v) setLabel(q.label);
        }}
      />
      <select
        className="padm__input padm__input--type"
        value={q.type}
        onChange={(e) => onSave({ type: e.target.value as PulseQuestionType })}
      >
        {(["weather5", "scale", "free_text"] as PulseQuestionType[]).map((t) => (
          <option key={t} value={t}>{QUESTION_TYPE_LABEL[t]}</option>
        ))}
      </select>
      <button
        className="padm__iconbtn padm__btn--danger"
        disabled={busy}
        onClick={() => { if (confirm("この設問を削除しますか？")) onDelete(); }}
        title="削除"
      >
        ×
      </button>
    </li>
  );
}

function Cycles({ onToast }: { onToast: (m: string) => void }) {
  const { sets, cycles, createCycle, sendCycle, closeCycle, busy } = usePulseAdminStore();
  const activeSets = sets.filter((s) => s.status === "active");
  const setName = (id: string) => {
    const s = sets.find((x) => x.id === id);
    return s ? `${s.name} v${s.version}` : "—";
  };

  const [period, setPeriod] = useState("");
  const [setId, setSetId] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [dueDate, setDueDate] = useState("");

  const onCreate = async () => {
    const res = await createCycle({
      period,
      question_set_id: setId,
      send_date: sendDate || null,
      due_date: dueDate || null,
    });
    onToast(res.ok ? "サイクルを作成しました（予定）" : res.reason ?? "作成に失敗しました");
    if (res.ok) {
      setPeriod("");
      setSendDate("");
      setDueDate("");
    }
  };

  const run = (label: string) => async (p: Promise<{ ok: boolean; reason?: string }>) => {
    const res = await p;
    onToast(res.ok ? label : res.reason ?? "操作に失敗しました");
  };

  return (
    <section className="padm__section">
      <h2 className="pdash__h2">配信サイクル</h2>
      <p className="pdash__muted padm__note">
        「受付開始」で回答フォーム（#/survey）が開きます。Slack/メールの自動配信はスライス7で追加予定です。
      </p>

      <div className="padm__cyclenew">
        <label className="palert__field">
          <span>対象月</span>
          <input className="padm__input" placeholder="2026-08" value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <label className="palert__field">
          <span>質問セット（有効のみ）</span>
          <select className="padm__input" value={setId} onChange={(e) => setSetId(e.target.value)}>
            <option value="">選択…</option>
            {activeSets.map((s) => (
              <option key={s.id} value={s.id}>{s.name} v{s.version}</option>
            ))}
          </select>
        </label>
        <label className="palert__field">
          <span>送信予定日</span>
          <input type="date" className="padm__input" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
        </label>
        <label className="palert__field">
          <span>締切日</span>
          <input type="date" className="padm__input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </label>
        <button
          className="pdash__btn pdash__btn--primary"
          disabled={busy || !period.trim() || !setId}
          onClick={onCreate}
        >
          サイクル作成
        </button>
      </div>

      {cycles.length === 0 && <p className="pdash__muted">サイクルがありません。</p>}
      <div className="padm__cyclelist">
        {cycles.map((c) => (
          <div key={c.id} className="padm__cyclerow">
            <span className="padm__cyclep">{periodLabel(c.period)}</span>
            <span className={`padm__badge padm__badge--cy-${c.status}`}>{CYCLE_STATUS_LABEL[c.status]}</span>
            <span className="padm__cycleset">{setName(c.question_set_id)}</span>
            <span className="padm__cycledates">
              {c.send_date ? `送信 ${c.send_date}` : ""} {c.due_date ? `／締切 ${c.due_date}` : ""}
            </span>
            <span className="padm__cycleactions">
              {c.status === "scheduled" && (
                <button
                  className="pdash__btn pdash__btn--primary"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`${periodLabel(c.period)} の受付を開始します（回答フォームが開きます）。よろしいですか？`))
                      run("受付を開始しました")(sendCycle(c.id));
                  }}
                >
                  受付開始
                </button>
              )}
              {c.status === "sent" && (
                <button
                  className="pdash__btn"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`${periodLabel(c.period)} を終了します（以降は回答不可）。よろしいですか？`))
                      run("終了しました")(closeCycle(c.id));
                  }}
                >
                  終了
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

export default PulseAdminPage;
