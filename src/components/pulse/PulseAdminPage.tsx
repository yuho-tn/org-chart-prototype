import { useEffect, useState } from "react";
import { CheckCircle2, Copy } from "lucide-react";
import "./pulse-shared.css";
import "./admin.css";
import "./alerts.css"; // .palert__field をサイクル作成フォームで再利用しているため
import { usePulseAdminStore, type NotifyResult, type PulseCycleStats } from "../../store/usePulseAdminStore";
import { PulseSubnav } from "./PulseSubnav";
import { usePulseToast, PulseToast, type PulseToastKind } from "./usePulseToast";
import {
  periodLabel,
  QUESTION_TYPE_LABEL,
  SET_STATUS_LABEL,
  CYCLE_STATUS_LABEL,
  type PulseQuestionSetRow,
  type PulseQuestionRow,
  type PulseQuestionType,
  type PulseCycleRow,
} from "../../lib/pulse";

/** #/survey の回答フォームURL。no_channel_configured 時の手動案内用（設計書 §6）。 */
const SURVEY_URL = "https://shosan-talent-hub.vercel.app/#/survey";

/**
 * パルスサーベイ 設定（#/pulse/admin）。質問セット＋設問＋配信サイクルの管理。
 * すべて admin 直書き（0021 の RLS＋不可変ガード）。
 * draft セットのみ設問編集可、active 化で凍結、クローンで新バージョン。
 * サイクルは scheduled→sent（受付開始）→closed。一斉送信/リマインドは pulse-notify Edge Function。
 */
export function PulseAdminPage() {
  const { loaded, loading, error, sets, cycles, load } = usePulseAdminStore();
  const { toast, showToast, clearToast } = usePulseToast();

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
          <OperationStepper sets={sets} cycles={cycles} />
          <QuestionSets onToast={showToast} />
          <Cycles onToast={showToast} />
        </>
      )}

      <PulseToast toast={toast} onDismiss={clearToast} />
    </main>
  );
}

/**
 * 運用ステッパー（設計書 §6）。ダッシュボードのオンボーディングと同じ4ステップの現在地を
 * 簡潔に示す。「一斉送信」は配信済みかどうかクライアントから判別できないため、受付中
 * サイクルがある間は常に「現在地」のまま表示する（次サイクル作成で①〜③へ戻る）。
 */
function OperationStepper({ sets, cycles }: { sets: PulseQuestionSetRow[]; cycles: PulseCycleRow[] }) {
  const hasActiveSet = sets.some((s) => s.status === "active");
  // cycles は period 降順（usePulseCyclesStore）＝ 先頭が最新サイクル。
  const latest = cycles[0];
  const allClosedOrNone = cycles.length === 0 || cycles.every((c) => c.status === "closed");

  let current: number;
  if (!hasActiveSet) current = 0;
  else if (allClosedOrNone) current = 1;
  else if (latest && latest.status === "scheduled") current = 2;
  else current = 3;

  const steps = ["設問セットを有効化", "サイクルを作成", "受付開始", "一斉送信"];

  return (
    <ol className="padm__stepper" aria-label="パルスサーベイ運用ステップ">
      {steps.map((label, i) => {
        const state = i < current ? "done" : i === current ? "current" : "upcoming";
        return (
          <li key={label} className={`padm__step padm__step--${state}`}>
            {state === "done" ? (
              <span className="padm__step-icon" aria-hidden="true">
                <CheckCircle2 size={16} />
              </span>
            ) : (
              <span className="padm__step-num" aria-hidden="true">{i + 1}</span>
            )}
            <span className="padm__step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function QuestionSets({ onToast }: { onToast: (kind: PulseToastKind, m: string) => void }) {
  const { sets, createSet, busy } = usePulseAdminStore();
  const [name, setName] = useState("");

  const onCreate = async () => {
    const res = await createSet(name);
    onToast(res.ok ? "success" : "error", res.ok ? "下書きセットを作成しました" : res.reason ?? "作成に失敗しました");
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

function SetCard({ set: s, onToast }: { set: PulseQuestionSetRow; onToast: (kind: PulseToastKind, m: string) => void }) {
  const { questionsBySet, activateSet, archiveSet, deleteSet, cloneSet, renameSet, busy } =
    usePulseAdminStore();
  const questions = questionsBySet[s.id] ?? [];
  const isDraft = s.status === "draft";
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);

  const run = (label: string) => async (p: Promise<{ ok: boolean; reason?: string }>) => {
    const res = await p;
    onToast(res.ok ? "success" : "error", res.ok ? label : res.reason ?? "操作に失敗しました");
  };

  const onActivate = async () => {
    if (questions.length === 0) {
      onToast("error", "設問が0件です。1問以上追加してください");
      return;
    }
    if (
      !confirm(
        `「${s.name} v${s.version}」を有効化します。有効化後は設問を編集できません（修正が必要な場合は「複製して新版」で新しい下書きを作ってください）。よろしいですか？`,
      )
    )
      return;
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
  onToast: (kind: PulseToastKind, m: string) => void;
}) {
  const { addQuestion, updateQuestion, deleteQuestion, moveQuestion, busy } = usePulseAdminStore();
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("");
  const [type, setType] = useState<PulseQuestionType>("weather5");

  const onAdd = async () => {
    const res = await addQuestion(setId, { label, category: category || null, type });
    onToast(res.ok ? "success" : "error", res.ok ? "設問を追加しました" : res.reason ?? "追加に失敗しました");
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
            // 行データの updated_at を key に含める: label/category はローカル state で
            // 編集するため、他画面/他セッションからの更新や type 変更後の再読込で
            // props と state がズレる（再同期しない）事故を key変更による強制remountで防ぐ。
            key={`${q.id}:${q.updated_at}`}
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
          {(["weather5", "scale", "nps", "free_text"] as PulseQuestionType[]).map((t) => (
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
        {(["weather5", "scale", "nps", "free_text"] as PulseQuestionType[]).map((t) => (
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

/** notifyCycle の戻り値をトースト用の短い1行に整形する。 */
function notifyResultToastText(mode: "broadcast" | "reminder", res: NotifyResult): string {
  if (res.noChannelConfigured) return "配信チャネル未設定です（下の案内を参照してください）";
  if (!res.ok) return res.reason ?? "配信に失敗しました";
  const verb = mode === "broadcast" ? "一斉送信" : "リマインド";
  return res.detail ? `${verb}を実行しました（対象${res.detail.targets}名）` : `${verb}を実行しました`;
}

/** notifyCycle 成功時の内訳を行内表示用に整形する。 */
function notifyResultDetailText(res: NotifyResult): string {
  const d = res.detail;
  if (!d) return "配信を実行しました";
  const parts = [`対象 ${d.targets}名`];
  if (d.channels.slack) parts.push(`Slack成功 ${d.slack_ok}件${d.slack_fail ? `（失敗${d.slack_fail}件）` : ""}`);
  if (d.channels.email) parts.push(`メール成功 ${d.email_ok}件${d.email_fail ? `（失敗${d.email_fail}件）` : ""}`);
  return parts.join(" ／ ");
}

function Cycles({ onToast }: { onToast: (kind: PulseToastKind, m: string) => void }) {
  const { sets, cycles, cycleStats, createCycle, sendCycle, closeCycle, notifyCycle, busy } = usePulseAdminStore();
  const activeSets = sets.filter((s) => s.status === "active");
  const setName = (id: string) => {
    const s = sets.find((x) => x.id === id);
    return s ? `${s.name} v${s.version}` : "—";
  };

  const [period, setPeriod] = useState("");
  const [setId, setSetId] = useState("");
  const [sendDate, setSendDate] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [notifyResults, setNotifyResults] = useState<Record<string, NotifyResult>>({});

  const onCreate = async () => {
    const res = await createCycle({
      period,
      question_set_id: setId,
      send_date: sendDate || null,
      due_date: dueDate || null,
    });
    onToast(res.ok ? "success" : "error", res.ok ? "サイクルを作成しました（予定）" : res.reason ?? "作成に失敗しました");
    if (res.ok) {
      setPeriod("");
      setSendDate("");
      setDueDate("");
    }
  };

  const run = (label: string) => async (p: Promise<{ ok: boolean; reason?: string }>) => {
    const res = await p;
    onToast(res.ok ? "success" : "error", res.ok ? label : res.reason ?? "操作に失敗しました");
  };

  const onNotify = async (c: PulseCycleRow, mode: "broadcast" | "reminder") => {
    const confirmMsg =
      mode === "broadcast"
        ? `${periodLabel(c.period)} の一斉送信（Slack DM＋メール）を全在籍者へ実行します。よろしいですか？`
        : `${periodLabel(c.period)} の未回答者へリマインドを送信します。よろしいですか？`;
    if (!confirm(confirmMsg)) return;
    const res = await notifyCycle(c.id, mode);
    setNotifyResults((m) => ({ ...m, [c.id]: res }));
    onToast(res.noChannelConfigured ? "error" : res.ok ? "success" : "error", notifyResultToastText(mode, res));
  };

  const onCopyUrl = async () => {
    try {
      await navigator.clipboard.writeText(SURVEY_URL);
      onToast("success", "回答URLをコピーしました");
    } catch {
      onToast("error", `コピーに失敗しました。手動でコピーしてください：${SURVEY_URL}`);
    }
  };

  return (
    <section className="padm__section">
      <h2 className="pdash__h2">配信サイクル</h2>
      <p className="pdash__muted padm__note">
        「受付開始」で回答フォーム（#/survey）が開きます（この時点では通知は送信されません）。続けて「一斉送信」を押すと全在籍者へ
        Slack DM＋メールで案内が届きます。締切前は「リマインド」で未回答者のみへ再送できます。
      </p>

      <div className="padm__cyclenew">
        <label className="palert__field">
          <span>対象月</span>
          <input type="month" className="padm__input" value={period} onChange={(e) => setPeriod(e.target.value)} />
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
          <CycleRow
            key={c.id}
            c={c}
            setLabel={setName(c.question_set_id)}
            stats={cycleStats[c.id]}
            notifyResult={notifyResults[c.id]}
            busy={busy}
            onSend={() => {
              if (confirm(`${periodLabel(c.period)} の受付を開始します（回答フォームが開きます）。よろしいですか？`))
                run("受付を開始しました")(sendCycle(c.id));
            }}
            onNotify={(mode) => onNotify(c, mode)}
            onClose={() => {
              if (confirm(`${periodLabel(c.period)} を終了します（以降は回答不可）。よろしいですか？`))
                run("終了しました")(closeCycle(c.id));
            }}
            onCopyUrl={onCopyUrl}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * 配信サイクル1行。回答進捗ミニバー（pulse_admin_cycle_stats）と、直前の
 * notifyCycle 結果（トーストだけでなく行内にも残す＝設計書 §6）を表示する。
 * ローカル state を持たない（props をそのまま描画）ため、QRow のような
 * 再同期ズレは起きない。
 */
function CycleRow({
  c,
  setLabel,
  stats,
  notifyResult,
  busy,
  onSend,
  onNotify,
  onClose,
  onCopyUrl,
}: {
  c: PulseCycleRow;
  setLabel: string;
  stats: PulseCycleStats | undefined;
  notifyResult: NotifyResult | undefined;
  busy: boolean;
  onSend: () => void;
  onNotify: (mode: "broadcast" | "reminder") => void;
  onClose: () => void;
  onCopyUrl: () => void;
}) {
  const rate = stats && stats.target > 0 ? stats.responses / stats.target : null;

  return (
    <div className="padm__cyclerow">
      <div className="padm__cyclerow-top">
        <span className="padm__cyclep">{periodLabel(c.period)}</span>
        <span className={`padm__badge padm__badge--cy-${c.status}`}>{CYCLE_STATUS_LABEL[c.status]}</span>
        <span className="padm__cycleset">{setLabel}</span>
        <span className="padm__cycledates">
          {c.send_date ? `送信 ${c.send_date}` : ""} {c.due_date ? `／締切 ${c.due_date}` : ""}
        </span>
        <span className="padm__cycleactions">
          {c.status === "scheduled" && (
            <button className="pdash__btn pdash__btn--primary" disabled={busy} onClick={onSend}>
              受付開始
            </button>
          )}
          {c.status === "sent" && (
            <>
              <button
                className="pdash__btn pdash__btn--primary"
                disabled={busy}
                onClick={() => onNotify("broadcast")}
                title="全在籍者へ Slack DM＋メールで案内を送信"
              >
                一斉送信
              </button>
              <button
                className="pdash__btn"
                disabled={busy}
                onClick={() => onNotify("reminder")}
                title="未回答者のみへリマインド送信"
              >
                リマインド
              </button>
              <button className="pdash__btn" disabled={busy} onClick={onClose}>
                終了
              </button>
            </>
          )}
        </span>
      </div>

      {stats && c.status !== "scheduled" && (
        <div className="padm__cycleprogress">
          <div className="padm__cycleprogress-track">
            <div
              className="padm__cycleprogress-fill"
              style={{ width: `${Math.min(100, Math.round((rate ?? 0) * 100))}%` }}
            />
          </div>
          <span className="padm__cycleprogress-label">
            {stats.responses}/{stats.target}
            {rate != null ? `・${Math.round(rate * 100)}%` : ""}
          </span>
        </div>
      )}

      {notifyResult && (
        <div className={"padm__notifyresult" + (notifyResult.ok ? "" : " padm__notifyresult--error")}>
          {notifyResult.noChannelConfigured ? (
            <>
              <p className="padm__notifyresult-msg">
                配信チャネル未設定です（Slack Bot Token／Resend API Key が両方とも未設定）。
                docs/PULSE_ACTIVATION_RUNBOOK.md を参照して設定するか、回答URLを手動でSlackへ投稿してください。
              </p>
              <button className="pdash__btn padm__copybtn" onClick={onCopyUrl}>
                <Copy size={13} aria-hidden="true" /> 回答URLをコピー
              </button>
            </>
          ) : (
            <p className="padm__notifyresult-msg">
              {notifyResult.ok ? notifyResultDetailText(notifyResult) : notifyResult.reason ?? "配信に失敗しました"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default PulseAdminPage;
