import { useEffect, useMemo, useState, type FocusEvent } from "react";
import { useMissionsStore, periodLabel, findAnswer } from "../../store/useMissionsStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { useProfilesStore } from "../../store/useProfilesStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import { employeeName } from "../../lib/supabase";
import {
  answerKey,
  canWriteAnswerClient,
  isAnswerFilled,
  isEvaluatorOfClient,
  questionPhase,
  questionRespondent,
  stageIndex,
  STAGE_LABELS,
  type AnswerValue,
  type MissionQuestion,
  type MissionRespondent,
  type MissionStage,
} from "../../lib/mission";
import { ConfirmDialog } from "../ConfirmDialog";
import { StageBadge, DeadlineBanner, StageProgress } from "./shared";

type SaveState = "saving" | "saved" | "error";

/**
 * #/missions/sheet/:id — シート記入・確認。
 * definition のセクション→設問を順に描画し、blur 時に mission_answers へ
 * 自動保存する。活性制御は canWriteAnswerClient のクライアントミラー —
 * 真の強制はサーバ側 RLS（mission_can_write_answer）で、0 行 upsert は
 * エラートーストとして表面化する。
 * ステージ操作は必ず rpc('mission_set_stage') 経由。第2弾ステージ
 * （mid/final/assessed）の操作ボタンは UI 非表示（表示のみ対応）。
 */
export function MissionSheetPage({ id }: { id: string }) {
  const sheets = useMissionsStore((s) => s.sheets);
  const templates = useMissionsStore((s) => s.templates);
  const answersBySheetId = useMissionsStore((s) => s.answersBySheetId);
  const eventsBySheetId = useMissionsStore((s) => s.eventsBySheetId);
  const periods = useMissionsStore((s) => s.periods);
  const fetchSheetDetail = useMissionsStore((s) => s.fetchSheetDetail);
  const saveAnswer = useMissionsStore((s) => s.saveAnswer);
  const setStage = useMissionsStore((s) => s.setStage);

  const employees = useEmployeesStore((s) => s.employees);
  const refreshEmployees = useEmployeesStore((s) => s.refresh);
  const positionLevels = useProfilesStore((s) => s.positionLevels);
  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const can = useProfilesStore((s) => s.can);
  const currentEmployeeNumber = useProfilesStore((s) => s.currentEmployeeNumber);
  const setToast = useOrgStore((s) => s.setToast);
  const navigate = useUiStore((s) => s.navigate);

  // id ごとのロード結果（effect 内の同期 setState を避けるため id 込みで持つ）
  const [loadState, setLoadState] = useState<{
    id: string;
    status: "loading" | "done" | "error";
    reason?: string;
  }>({ id: "", status: "loading" });
  const detailLoading = loadState.id !== id || loadState.status === "loading";
  const detailError =
    loadState.id === id && loadState.status === "error"
      ? loadState.reason ?? "読み込みに失敗しました"
      : null;

  useEffect(() => {
    let cancelled = false;
    void fetchSheetDetail(id).then((res) => {
      if (cancelled) return;
      setLoadState({
        id,
        status: res.ok ? "done" : "error",
        reason: res.reason,
      });
    });
    if (employees.length === 0) refreshEmployees();
    if (!profilesLoaded) refreshProfiles();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const sheet = sheets.find((s) => s.id === id) ?? null;
  const template = sheet
    ? templates.find((t) => t.id === sheet.template_id) ?? null
    : null;
  const answers = answersBySheetId[id];
  const events = eventsBySheetId[id] ?? [];

  const me = currentEmployeeNumber();
  const meEmp = useMemo(
    () => employees.find((e) => e.employee_number === me) ?? null,
    [employees, me],
  );
  const targetEmp = useMemo(
    () =>
      sheet
        ? employees.find((e) => e.employee_number === sheet.employee_number) ?? null
        : null,
    [employees, sheet],
  );

  const canManage = can("mission", "manage");
  // サーバ側 is_mission_evaluator_of のミラー: 部署一致上位 OR evaluate_any
  const isEvaluator =
    isEvaluatorOfClient(meEmp, targetEmp, positionLevels) ||
    can("mission", "evaluate_any");
  const isSelf = !!me && !!sheet && sheet.employee_number === me;

  // 設問ごとの保存状態（answerKey → saving/saved/error）
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({});
  // required 未記入で提出しようとした時の警告リスト
  const [missingLabels, setMissingLabels] = useState<string[]>([]);
  // ステージ操作の確認ダイアログ
  const [confirming, setConfirming] = useState<"submit" | "confirm" | null>(null);
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");

  async function handleSaveAnswer(
    q: MissionQuestion,
    role: MissionRespondent,
    value: AnswerValue,
  ) {
    const key = answerKey(q.id, role);
    setSaveStates((s) => ({ ...s, [key]: "saving" }));
    const res = await saveAnswer(id, q.id, role, value);
    setSaveStates((s) => ({ ...s, [key]: res.ok ? "saved" : "error" }));
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "回答の保存に失敗しました" });
    }
  }

  /** required（本人・goal フェーズ）の未記入設問ラベルを列挙する。 */
  function collectMissingRequired(): string[] {
    if (!template) return [];
    const labels: string[] = [];
    for (const sec of template.definition.sections) {
      for (const q of sec.questions) {
        if (q.type === "heading" || !q.required) continue;
        const resp = questionRespondent(q);
        if (resp !== "self" && resp !== "both") continue;
        if (questionPhase(q) !== "goal") continue;
        const ans = findAnswer(answers, q.id, "self");
        if (!isAnswerFilled(q, ans?.value)) labels.push(q.label);
      }
    }
    return labels;
  }

  function handleSubmitClick() {
    const missing = collectMissingRequired();
    if (missing.length > 0) {
      // 未記入がある場合は提出をブロックして列挙警告
      setMissingLabels(missing);
      setToast({
        kind: "error",
        message: `必須設問が${missing.length}件未記入です。記入してから提出してください。`,
      });
      return;
    }
    setMissingLabels([]);
    setConfirming("submit");
  }

  async function doSetStage(toStage: MissionStage, reason?: string) {
    const res = await setStage(id, toStage, reason);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "ステージ変更に失敗しました" });
      return;
    }
    setToast({ kind: "info", message: `「${STAGE_LABELS[toStage]}」に更新しました` });
  }

  if (detailLoading && !sheet) {
    return (
      <main className="page">
        <p className="empdetail__empty">読み込み中…</p>
      </main>
    );
  }

  if (detailError && !sheet) {
    return (
      <main className="page">
        <p className="versions__error">{detailError}</p>
        <button className="btn btn--ghost" onClick={() => navigate({ name: "missions" })}>
          ← ミッションへ戻る
        </button>
      </main>
    );
  }

  if (!sheet) {
    return (
      <main className="page">
        <p className="versions__error">シートが見つかりません。</p>
        <button className="btn btn--ghost" onClick={() => navigate({ name: "missions" })}>
          ← ミッションへ戻る
        </button>
      </main>
    );
  }

  const stage = sheet.stage;
  // 差し戻し先（第1弾は goal 段階のみ UI 提供）
  const returnTarget: MissionStage | null =
    stage === "goal_submitted" ? "issued" : stage === "goal_confirmed" ? "goal_submitted" : null;
  const showEvaluatorActions = (isEvaluator || canManage) && !isSelf;

  return (
    <main className="page mission__sheetPage">
      <div className="page__header">
        <div>
          <h1 className="page__title">
            {targetEmp ? employeeName(targetEmp) : sheet.employee_number} さんのミッションシート
          </h1>
          <p className="page__subtitle">
            {periodLabel(sheet.period, periods)}｜{template?.title ?? ""}
            {targetEmp?.department ? `｜${targetEmp.department}` : ""}
            {targetEmp?.position_title ? `（${targetEmp.position_title}）` : ""}
          </p>
        </div>
        <div className="page__actions">
          <StageBadge stage={stage} />
          <button className="btn btn--ghost" onClick={() => navigate({ name: "missions" })}>
            ← ミッションへ
          </button>
        </div>
      </div>

      <StageProgress stage={stage} />
      <DeadlineBanner template={template} stage={stage} />

      {missingLabels.length > 0 && (
        <div className="mission__warnbox">
          <strong>必須設問が未記入のため提出できません:</strong>
          <ul>
            {missingLabels.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── 設問本体 ── */}
      {!template && (
        <p className="versions__error">
          テンプレートを読み込めませんでした。再読み込みしてください。
        </p>
      )}
      {template?.definition.sections.map((sec) => (
        <div key={sec.id} className="mission__section">
          <h3 className="mission__sectionTitle">{sec.title}</h3>
          {sec.description && <p className="mission__sectionDesc">{sec.description}</p>}
          {sec.questions.map((q) => {
            if (q.type === "heading") {
              return <h4 key={q.id} className="mission__qheading">{q.label}</h4>;
            }
            const resp = questionRespondent(q);
            const roles: MissionRespondent[] =
              resp === "both" ? ["self", "evaluator"] : [resp];
            return (
              <div key={q.id} className="mission__q">
                <div className="mission__qlabel">
                  {q.label}
                  {q.required && <span className="mission__required">＊必須</span>}
                </div>
                {q.help && <p className="mission__qhelp">{q.help}</p>}
                {roles.map((role) => {
                  const ans = findAnswer(answers, q.id, role);
                  const editable = canWriteAnswerClient(
                    q,
                    role,
                    sheet,
                    me,
                    isEvaluator,
                    canManage,
                  );
                  const key = answerKey(q.id, role);
                  // key に updated_at を含めない — 保存成功で updated_at が
                  // 変わるたび行がリマウントされ、フォーカス喪失・入力中
                  // テキスト消失を起こすため（外部更新の同期は各フィールド
                  // 側で「非フォーカス時のみ props から再同期」で行う）
                  return (
                    <div
                      key={key}
                      className={`mission__answerRow ${editable ? "" : "is-disabled"}`}
                    >
                      {role === "evaluator" && (
                        <span className="mission__qbadge">上長評価</span>
                      )}
                      <AnswerField
                        question={q}
                        value={ans?.value ?? null}
                        editable={editable}
                        showActual={stageIndex(stage) >= stageIndex("mid_done")}
                        onSave={(v) => handleSaveAnswer(q, role, v)}
                      />
                      <span className="mission__savestate">
                        {saveStates[key] === "saving" && "保存中…"}
                        {saveStates[key] === "saved" && "✓ 保存済み"}
                        {saveStates[key] === "error" && "⚠ 保存失敗"}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      ))}

      {/* ── アクション（第1弾: 期初面談=goal_confirmed まで） ── */}
      <div className="mission__actions">
        {isSelf && stage === "issued" && (
          <button className="btn btn--primary" onClick={handleSubmitClick}>
            提出する
          </button>
        )}
        {isSelf && stage === "goal_submitted" && (
          <p className="empdetail__hint">
            上長の確認待ちです。期初確定までは記入内容を修正できます。
          </p>
        )}
        {showEvaluatorActions && stage === "goal_submitted" && (
          <button className="btn btn--primary" onClick={() => setConfirming("confirm")}>
            期初面談完了として確定
          </button>
        )}
        {showEvaluatorActions && returnTarget && (
          <button
            className="btn btn--ghost"
            onClick={() => {
              setReturnReason("");
              setReturning(true);
            }}
          >
            差し戻す
          </button>
        )}
      </div>

      {/* ── 遷移履歴 ── */}
      {events.length > 0 && (
        <div className="mission__history">
          <h3 className="mission__sectionTitle">遷移履歴</h3>
          <ul>
            {events.map((ev) => (
              <li key={ev.id}>
                <span className="mission__historyDate">
                  {ev.created_at.slice(0, 16).replace("T", " ")}
                </span>
                {ev.from_stage ? `${STAGE_LABELS[ev.from_stage]} → ` : ""}
                <strong>{STAGE_LABELS[ev.to_stage]}</strong>
                <span className="mission__historyActor">（{ev.actor_email}）</span>
                {ev.reason && <span className="mission__historyReason">理由: {ev.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {confirming === "submit" && (
        <ConfirmDialog
          title="ミッションシートの提出"
          message="期初目標を提出します。提出後も期初確定までは記入内容を修正できます。よろしいですか？"
          confirmLabel="提出する"
          onConfirm={() => {
            setConfirming(null);
            void doSetStage("goal_submitted");
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === "confirm" && (
        <ConfirmDialog
          title="期初面談完了として確定"
          message="期初目標を確定します。確定後、本人は期初設問を編集できなくなります。よろしいですか？"
          confirmLabel="確定する"
          onConfirm={() => {
            setConfirming(null);
            void doSetStage("goal_confirmed");
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {returning && returnTarget && (
        <ConfirmDialog
          title="差し戻す"
          message={`ステージを「${STAGE_LABELS[returnTarget]}」に戻します。差し戻し理由は必須です（本人に履歴として表示されます）。`}
          confirmLabel="差し戻す"
          variant="danger"
          onConfirm={() => {
            if (!returnReason.trim()) {
              setToast({ kind: "error", message: "差し戻し理由を入力してください" });
              return;
            }
            setReturning(false);
            void doSetStage(returnTarget, returnReason.trim());
          }}
          onCancel={() => setReturning(false)}
        >
          <textarea
            className="field__input"
            style={{ width: "100%", marginTop: 8 }}
            rows={3}
            placeholder="差し戻し理由（必須）"
            value={returnReason}
            onChange={(e) => setReturnReason(e.target.value)}
          />
        </ConfirmDialog>
      )}
    </main>
  );
}

// ── 設問入力フィールド ────────────────────────────────────────────────

function AnswerField({
  question,
  value,
  editable,
  showActual,
  onSave,
}: {
  question: MissionQuestion;
  value: AnswerValue | null;
  editable: boolean;
  /** kpi_goal の実績欄（第2弾領域）を表示するか（mid_done 以降）。 */
  showActual: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  if (question.type === "kpi_goal") {
    return (
      <KpiField
        value={value}
        editable={editable}
        showActual={showActual}
        onSave={onSave}
      />
    );
  }
  if (question.type === "number") {
    return (
      <NumberField value={value} editable={editable} onSave={onSave} />
    );
  }
  if (question.type === "select") {
    return (
      <SelectField
        choices={question.choices ?? []}
        value={value}
        editable={editable}
        onSave={onSave}
      />
    );
  }
  return (
    <TextField
      multiline={question.type === "textarea"}
      value={value}
      editable={editable}
      onSave={onSave}
    />
  );
}

function TextField({
  multiline,
  value,
  editable,
  onSave,
}: {
  multiline: boolean;
  value: AnswerValue | null;
  editable: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const saved = value?.text ?? "";
  const [text, setText] = useState(saved);
  const [focused, setFocused] = useState(false);
  // 外部更新（保存成功・他者更新）の同期: リマウント（key 変更）に頼らず、
  // 非フォーカス時のみ props から再同期する（入力中テキストを潰さない）
  const [syncedSaved, setSyncedSaved] = useState(saved);
  if (saved !== syncedSaved) {
    setSyncedSaved(saved);
    if (!focused) setText(saved);
  }
  function handleBlur() {
    setFocused(false);
    if (text === saved) return; // 変更なしなら保存しない
    onSave({ text });
  }
  if (multiline) {
    return (
      <textarea
        className="field__input mission__answerInput"
        rows={3}
        value={text}
        disabled={!editable}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
      />
    );
  }
  return (
    <input
      className="field__input mission__answerInput"
      value={text}
      disabled={!editable}
      onChange={(e) => setText(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    />
  );
}

function NumberField({
  value,
  editable,
  onSave,
}: {
  value: AnswerValue | null;
  editable: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const saved = value?.number != null ? String(value.number) : "";
  const [num, setNum] = useState<string>(saved);
  const [focused, setFocused] = useState(false);
  // 非フォーカス時のみ props から再同期（TextField と同型）
  const [syncedSaved, setSyncedSaved] = useState(saved);
  if (saved !== syncedSaved) {
    setSyncedSaved(saved);
    if (!focused) setNum(saved);
  }
  function handleBlur() {
    setFocused(false);
    if (num === saved) return;
    onSave({ number: num === "" ? null : Number(num) });
  }
  return (
    <input
      className="field__input mission__answerInput mission__answerInput--num"
      type="number"
      value={num}
      disabled={!editable}
      onChange={(e) => setNum(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    />
  );
}

function SelectField({
  choices,
  value,
  editable,
  onSave,
}: {
  choices: string[];
  value: AnswerValue | null;
  editable: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const current = value?.text ?? "";
  return (
    <select
      className="field__input mission__answerInput"
      value={current}
      disabled={!editable}
      onChange={(e) => {
        // select は change 即保存（blur だと未変更のまま閉じるケースがあるため）
        if (e.target.value !== current) onSave({ text: e.target.value });
      }}
    >
      <option value="">— 選択してください —</option>
      {choices.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  );
}

function KpiField({
  value,
  editable,
  showActual,
  onSave,
}: {
  value: AnswerValue | null;
  editable: boolean;
  showActual: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const fromValue = (v: AnswerValue | null): AnswerValue => ({
    title: v?.title ?? "",
    metric: v?.metric ?? "",
    target_value: v?.target_value ?? null,
    unit: v?.unit ?? "",
    actual_value: v?.actual_value ?? null,
    achievement_rate: v?.achievement_rate ?? null,
  });
  const [kpi, setKpi] = useState<AnswerValue>(() => fromValue(value));
  const [focused, setFocused] = useState(false);
  // 非フォーカス時のみ props から再同期（TextField と同型・参照比較）
  const [syncedValue, setSyncedValue] = useState(value);
  if (value !== syncedValue) {
    setSyncedValue(value);
    if (!focused) setKpi(fromValue(value));
  }
  function handleBlur(e: FocusEvent<HTMLDivElement>) {
    // focusout はバブルするため、子フィールド間のタブ移動でも発火する。
    // 移動先（relatedTarget）がコンテナ内なら保存しない（フォーカスが
    // ウィジェット外へ出た時と relatedTarget=null の時のみ保存する）。
    if (e.relatedTarget && e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }
    setFocused(false);
    const same =
      (value?.title ?? "") === (kpi.title ?? "") &&
      (value?.metric ?? "") === (kpi.metric ?? "") &&
      (value?.target_value ?? null) === (kpi.target_value ?? null) &&
      (value?.unit ?? "") === (kpi.unit ?? "") &&
      (value?.actual_value ?? null) === (kpi.actual_value ?? null);
    if (same) return;
    onSave(kpi);
  }
  return (
    <div
      className="mission__kpi"
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    >
      <label className="mission__kpiField">
        目標名
        <input
          className="field__input field__input--xs"
          value={kpi.title ?? ""}
          disabled={!editable}
          onChange={(e) => setKpi({ ...kpi, title: e.target.value })}
        />
      </label>
      <label className="mission__kpiField">
        指標
        <input
          className="field__input field__input--xs"
          value={kpi.metric ?? ""}
          disabled={!editable}
          placeholder="例: 受注金額"
          onChange={(e) => setKpi({ ...kpi, metric: e.target.value })}
        />
      </label>
      <label className="mission__kpiField">
        目標値
        <input
          className="field__input field__input--xs"
          type="number"
          value={kpi.target_value ?? ""}
          disabled={!editable}
          onChange={(e) =>
            setKpi({
              ...kpi,
              target_value: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </label>
      <label className="mission__kpiField">
        単位
        <input
          className="field__input field__input--xs"
          value={kpi.unit ?? ""}
          disabled={!editable}
          placeholder="例: 万円"
          onChange={(e) => setKpi({ ...kpi, unit: e.target.value })}
        />
      </label>
      {showActual && (
        <label className="mission__kpiField">
          実績値（期末）
          <input
            className="field__input field__input--xs"
            type="number"
            value={kpi.actual_value ?? ""}
            disabled={!editable}
            onChange={(e) =>
              setKpi({
                ...kpi,
                actual_value: e.target.value === "" ? null : Number(e.target.value),
              })
            }
          />
        </label>
      )}
    </div>
  );
}
