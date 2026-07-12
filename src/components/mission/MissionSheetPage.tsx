import { useEffect, useMemo, useState, type FocusEvent } from "react";
import { useMissionsStore, periodLabel, findAnswer } from "../../store/useMissionsStore";
import { useAuthStore } from "../../store/useAuthStore";
import { useEmployeesStore } from "../../store/useEmployeesStore";
import { useProfilesStore } from "../../store/useProfilesStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import { canAccessPayroll, employeeName } from "../../lib/supabase";
import {
  answerKey,
  canWriteAnswerClient,
  collectFinalMissing,
  CREDO_EVAL_SCALE,
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
  type RankComputedResult,
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
 * ステージ操作は必ず rpc('mission_set_stage') 経由。査定確定のみ
 * rpc('mission_assess')（計算・凍結を伴う）。ランク計算はサーバの
 * calc_mission_rank_v1() を単一実装として共用する（プレビューも同関数）。
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
  const previewRank = useMissionsStore((s) => s.previewRank);
  const assess = useMissionsStore((s) => s.assess);
  const currentUser = useAuthStore((s) => s.currentUser);

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
  const [confirming, setConfirming] = useState<
    "submit" | "confirm" | "mid" | "finalSubmit" | "assess" | null
  >(null);
  const [returning, setReturning] = useState(false);
  const [returnReason, setReturnReason] = useState("");
  // ランク計算プレビュー（sheetId 込みで持ち、別シートへの持ち越しを防ぐ）
  const [preview, setPreview] = useState<{
    sheetId: string;
    result: RankComputedResult;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [assessing, setAssessing] = useState(false);

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
    } else {
      // 回答が変わったら計算プレビューは陳腐化するので破棄する
      setPreview(null);
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

  /** 期末提出前のクライアント側チェック（真の強制はサーバ側 RPC）。 */
  function handleFinalSubmitClick() {
    const missing = template ? collectFinalMissing(template.definition, answers) : [];
    if (missing.length > 0) {
      setMissingLabels(missing);
      setToast({
        kind: "error",
        message: `期末の必須項目が${missing.length}件未記入です。記入してから提出してください。`,
      });
      return;
    }
    setMissingLabels([]);
    setConfirming("finalSubmit");
  }

  async function doSetStage(toStage: MissionStage, reason?: string) {
    const res = await setStage(id, toStage, reason);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "ステージ変更に失敗しました" });
      return;
    }
    setPreview(null); // ステージが変わったらプレビューは陳腐化
    setToast({ kind: "info", message: `「${STAGE_LABELS[toStage]}」に更新しました` });
  }

  async function handlePreviewRank() {
    setPreviewLoading(true);
    const res = await previewRank(id);
    setPreviewLoading(false);
    if (!res.ok || !res.result) {
      setToast({ kind: "error", message: res.reason ?? "ランク計算に失敗しました" });
      return;
    }
    setPreview({ sheetId: id, result: res.result });
  }

  async function doAssess() {
    setAssessing(true);
    const res = await assess(id);
    setAssessing(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "査定確定に失敗しました" });
      return;
    }
    setPreview(null);
    setToast({
      kind: "info",
      message: `査定を確定しました（ランク: ${res.result?.rank ?? "—"}）`,
    });
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
  // 差し戻し先（1つ戻す）。assessed からの取り消しは manage のみ
  //（サーバ側でも強制・凍結値クリア）。
  const returnTarget: MissionStage | null =
    stage === "goal_submitted"
      ? "issued"
      : stage === "goal_confirmed"
        ? "goal_submitted"
        : stage === "mid_done"
          ? "goal_confirmed"
          : stage === "final_submitted"
            ? "mid_done"
            : stage === "assessed" && canManage
              ? "final_submitted"
              : null;
  const showEvaluatorActions = (isEvaluator || canManage) && !isSelf;
  // 査定確定後の凍結結果（プレビューと同じ形）
  const frozenResult =
    stage === "assessed" && sheet.computed_result
      ? (sheet.computed_result as unknown as RankComputedResult)
      : null;
  const payrollAllowed = canAccessPayroll(currentUser?.role);

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
                {q.type === "credo_eval" && q.credo && (
                  <div className="mission__credoMeta">
                    {q.credo.no && <span className="mission__credoNo">CREDO {q.credo.no}</span>}
                    {q.credo.phrase && (
                      <span className="mission__credoPhrase">「{q.credo.phrase}」</span>
                    )}
                    {q.credo.detail && (
                      <p className="mission__credoDetail">{q.credo.detail}</p>
                    )}
                  </div>
                )}
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
                        role={role}
                        value={ans?.value ?? null}
                        editable={editable}
                        showActual={stageIndex(stage) >= stageIndex("mid_done")}
                        goalLocked={stageIndex(stage) >= stageIndex("goal_confirmed")}
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

      {/* ── ランク計算（final_submitted: プレビュー／assessed: 凍結結果） ── */}
      {(isEvaluator || canManage) && stage === "final_submitted" && (
        <div className="mission__rankPanel">
          <div className="mission__rankPanelHead">
            <h3 className="mission__sectionTitle">ランク計算プレビュー</h3>
            <button
              className="btn btn--ghost btn--xs"
              disabled={previewLoading}
              onClick={handlePreviewRank}
            >
              {previewLoading ? "計算中…" : preview ? "再計算" : "計算する"}
            </button>
          </div>
          <p className="empdetail__hint">
            計算式: Σ(ウエイト×達成度) ＋ 加点。アタリマエ評価に✕があるとCが上限。
            確定するまでシートには保存されません。
          </p>
          {preview?.sheetId === id && <RankResultView result={preview.result} />}
          {canManage && (
            <div className="mission__actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn--primary"
                disabled={assessing}
                onClick={() => setConfirming("assess")}
              >
                {assessing ? "確定中…" : "査定を確定する（assessed）"}
              </button>
            </div>
          )}
        </div>
      )}

      {frozenResult && (
        <div className="mission__rankPanel mission__rankPanel--frozen">
          <div className="mission__rankPanelHead">
            <h3 className="mission__sectionTitle">査定結果（確定済み）</h3>
            <span className="mission__rankBadge">{sheet.final_grade ?? frozenResult.rank}</span>
          </div>
          <RankResultView result={frozenResult} />
          {payrollAllowed && (
            <div className="mission__actions" style={{ marginTop: 12 }}>
              <button
                className="btn btn--ghost"
                onClick={() => navigate({ name: "salary" })}
              >
                💰 給与管理（Payroll）で査定グレードを反映する
              </button>
              <p className="empdetail__hint">
                salary_records への自動書込みは行いません。給与表画面で該当者の
                評価ランク・次期給与を手動確定してください。
              </p>
            </div>
          )}
        </div>
      )}

      {/* ── アクション ── */}
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
        {isSelf && stage === "goal_confirmed" && (
          <p className="empdetail__hint">
            期初目標は確定済みです。中間振り返り設問を記入できます（中間面談の完了操作は上長が行います）。
          </p>
        )}
        {isSelf && stage === "mid_done" && (
          <p className="empdetail__hint">
            期末フェーズです。KPIの実績値と期末設問を記入してください（期末提出の操作は上長が行います）。
          </p>
        )}
        {showEvaluatorActions && stage === "goal_submitted" && (
          <button className="btn btn--primary" onClick={() => setConfirming("confirm")}>
            期初面談完了として確定
          </button>
        )}
        {showEvaluatorActions && stage === "goal_confirmed" && (
          <button className="btn btn--primary" onClick={() => setConfirming("mid")}>
            中間面談完了として記録
          </button>
        )}
        {showEvaluatorActions && stage === "mid_done" && (
          <button className="btn btn--primary" onClick={handleFinalSubmitClick}>
            期末評価を提出する
          </button>
        )}
        {(showEvaluatorActions || (stage === "assessed" && canManage)) && returnTarget && (
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

      {confirming === "mid" && (
        <ConfirmDialog
          title="中間面談完了として記録"
          message="中間振り返りを完了し、期末フェーズ（KPI実績・期末設問の記入）へ進めます。中間設問は以後編集できなくなります。よろしいですか？"
          confirmLabel="中間完了にする"
          onConfirm={() => {
            setConfirming(null);
            void doSetStage("mid_done");
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === "finalSubmit" && (
        <ConfirmDialog
          title="期末評価の提出"
          message="期末評価を提出します。提出後は記入内容を編集できません（査定確定は管理者が行います）。よろしいですか？"
          confirmLabel="提出する"
          onConfirm={() => {
            setConfirming(null);
            void doSetStage("final_submitted");
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {confirming === "assess" && (
        <ConfirmDialog
          title="査定を確定する"
          message={
            <>
              ランクを計算してシートに凍結し、ステージを「査定確定」にします。
              確定後は全設問が読み取り専用になります。
              {preview?.sheetId === id && (
                <>
                  <br />
                  現在のプレビュー: <strong>合計 {preview.result.total}点 → ランク {preview.result.rank}</strong>
                </>
              )}
              よろしいですか？
            </>
          }
          confirmLabel="確定する"
          onConfirm={() => {
            setConfirming(null);
            void doAssess();
          }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {returning && returnTarget && (
        <ConfirmDialog
          title="差し戻す"
          message={
            stage === "assessed"
              ? `査定確定を取り消してステージを「${STAGE_LABELS[returnTarget]}」に戻します。凍結済みのランク・計算結果はクリアされます。差し戻し理由は必須です。`
              : `ステージを「${STAGE_LABELS[returnTarget]}」に戻します。差し戻し理由は必須です（本人に履歴として表示されます）。`
          }
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

// ── ランク計算結果の表示（プレビュー・凍結結果 共用） ─────────────────

function RankResultView({ result }: { result: RankComputedResult }) {
  const warn: string[] = [];
  if (result.weights_total !== 100) {
    warn.push(`ウエイト合計が${result.weights_total}点です（100点想定）`);
  }
  for (const l of result.missing_inputs ?? []) warn.push(`上長の達成度が未入力: ${l}`);
  for (const l of result.fundamental_missing ?? []) warn.push(`アタリマエ評価が未入力: ${l}`);
  return (
    <div className="mission__rankResult">
      <div className="mission__rankSummary">
        <div className="mission__rankTotal">
          <span className="mission__rankTotalNum">{result.total}</span>点
          <span className="mission__rankArrow">→</span>
          <span className="mission__rankBadge">{result.rank}</span>
        </div>
        <div className="mission__rankBreakdownNums">
          ミッション {result.mission_score}点 ＋ 加点 {result.bonus_score}点
          {result.fundamental_fail && (
            <span className="mission__rankCapNote">
              ⚠ アタリマエ✕（{(result.fundamental_fails ?? []).join("、")}）→ C上限
              {result.rank_before_cap !== result.rank &&
                `（計算上は${result.rank_before_cap}）`}
            </span>
          )}
        </div>
      </div>
      {(result.items ?? []).length > 0 && (
        <table className="empmgr__table mission__rankTable">
          <thead>
            <tr>
              <th>ミッション</th>
              <th style={{ width: 90 }}>ウエイト</th>
              <th style={{ width: 100 }}>達成度</th>
              <th style={{ width: 90 }}>点数</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((it) => (
              <tr key={it.question_id}>
                <td>{it.label}</td>
                <td>{it.weight}</td>
                <td>{it.achievement_rate != null ? `${it.achievement_rate}%` : "—"}</td>
                <td>{it.score}</td>
              </tr>
            ))}
            {(result.bonus_items ?? []).map((b) => (
              <tr key={b.question_id}>
                <td>{b.label}（加点）</td>
                <td>—</td>
                <td>—</td>
                <td>{b.points ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {warn.length > 0 && (
        <ul className="mission__rankWarns">
          {warn.map((w) => (
            <li key={w}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── 設問入力フィールド ────────────────────────────────────────────────

function AnswerField({
  question,
  role,
  value,
  editable,
  showActual,
  goalLocked,
  onSave,
}: {
  question: MissionQuestion;
  role: MissionRespondent;
  value: AnswerValue | null;
  editable: boolean;
  /** kpi_goal の実績欄／credo_eval の期末評価欄を表示するか（mid_done 以降）。 */
  showActual: boolean;
  /** 期初確定済みか（kpi_goal の目標系・credo_eval の期初系をロック。サーバトリガのミラー）。 */
  goalLocked: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  if (question.type === "kpi_goal") {
    return (
      <KpiField
        value={value}
        editable={editable}
        showActual={showActual}
        goalLocked={goalLocked}
        onSave={onSave}
      />
    );
  }
  if (question.type === "credo_eval") {
    return (
      <CredoEvalField
        scale={question.scale?.length ? question.scale : CREDO_EVAL_SCALE}
        role={role}
        value={value}
        editable={editable}
        showFinal={showActual}
        goalLocked={goalLocked}
        onSave={onSave}
      />
    );
  }
  if (question.type === "date") {
    return <DateField value={value} editable={editable} onSave={onSave} />;
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

function DateField({
  value,
  editable,
  onSave,
}: {
  value: AnswerValue | null;
  editable: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const saved = value?.date ?? "";
  const [date, setDate] = useState(saved);
  const [focused, setFocused] = useState(false);
  // 非フォーカス時のみ props から再同期（TextField と同型）
  const [syncedSaved, setSyncedSaved] = useState(saved);
  if (saved !== syncedSaved) {
    setSyncedSaved(saved);
    if (!focused) setDate(saved);
  }
  function handleBlur() {
    setFocused(false);
    if (date === saved) return;
    onSave({ date });
  }
  return (
    <input
      className="field__input mission__answerInput mission__answerInput--date"
      type="date"
      value={date}
      disabled={!editable}
      onChange={(e) => setDate(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
    />
  );
}

/**
 * credo_eval の入力欄（1 行 = 1 ロール）。
 * - self 行: 注力テーマチェック＋期初評価。期末評価は mid_done 以降に表示。
 * - evaluator 行: 期初評価＋期末評価（同上）。
 * 期初系（focus / goal_eval）は goalLocked（期初確定以降）で不活性 —
 * サーバ側 mission_answers_credo_guard トリガのミラー。
 * 保存は選択即保存（SelectField と同じ理由）で、既存 value にマージする。
 */
function CredoEvalField({
  scale,
  role,
  value,
  editable,
  showFinal,
  goalLocked,
  onSave,
}: {
  scale: string[];
  role: MissionRespondent;
  value: AnswerValue | null;
  editable: boolean;
  showFinal: boolean;
  goalLocked: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const cur: AnswerValue = value ?? {};
  const goalEditable = editable && !goalLocked;
  const finalEditable = editable && showFinal;

  function ScaleRow({
    label,
    field,
    enabled,
  }: {
    label: string;
    field: "goal_eval" | "final_eval";
    enabled: boolean;
  }) {
    const selected = cur[field] ?? "";
    return (
      <div className="mission__credoRow">
        <span className="mission__credoRowLabel">{label}</span>
        <div className="mission__scale" role="radiogroup" aria-label={label}>
          {scale.map((mark) => (
            <button
              key={mark}
              type="button"
              className={`mission__scaleBtn ${selected === mark ? "is-selected" : ""}`}
              disabled={!enabled}
              aria-pressed={selected === mark}
              onClick={() => {
                if (mark !== selected) onSave({ ...cur, [field]: mark });
              }}
            >
              {mark}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mission__credoEval">
      {role === "self" && (
        <label className="mission__credoFocus">
          <input
            type="checkbox"
            checked={!!cur.focus}
            disabled={!goalEditable}
            onChange={(e) => onSave({ ...cur, focus: e.target.checked })}
          />
          今期の注力テーマにする
        </label>
      )}
      <ScaleRow label="期初評価" field="goal_eval" enabled={goalEditable} />
      {showFinal && (
        <ScaleRow label="期末評価" field="final_eval" enabled={finalEditable} />
      )}
    </div>
  );
}

function KpiField({
  value,
  editable,
  showActual,
  goalLocked,
  onSave,
}: {
  value: AnswerValue | null;
  editable: boolean;
  showActual: boolean;
  /** 期初確定後は目標系4フィールドを不活性化（編集してもサーバトリガで拒否されるため）。 */
  goalLocked: boolean;
  onSave: (v: AnswerValue) => void;
}) {
  const goalEditable = editable && !goalLocked;
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
      (value?.actual_value ?? null) === (kpi.actual_value ?? null) &&
      (value?.achievement_rate ?? null) === (kpi.achievement_rate ?? null);
    if (same) return;
    onSave(kpi);
  }
  // 実績/目標から機械計算した参考値（達成度は加点基準等を踏まえた手入力が正）
  const suggestedRate =
    kpi.actual_value != null && kpi.target_value != null && kpi.target_value !== 0
      ? Math.round((kpi.actual_value / kpi.target_value) * 1000) / 10
      : null;
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
          disabled={!goalEditable}
          onChange={(e) => setKpi({ ...kpi, title: e.target.value })}
        />
      </label>
      <label className="mission__kpiField">
        指標
        <input
          className="field__input field__input--xs"
          value={kpi.metric ?? ""}
          disabled={!goalEditable}
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
          disabled={!goalEditable}
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
          disabled={!goalEditable}
          placeholder="例: 万円"
          onChange={(e) => setKpi({ ...kpi, unit: e.target.value })}
        />
      </label>
      {showActual && (
        <>
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
          <label className="mission__kpiField">
            達成度（%）
            <input
              className="field__input field__input--xs"
              type="number"
              value={kpi.achievement_rate ?? ""}
              disabled={!editable}
              placeholder="100=達成"
              title="100=達成基準クリア。加点基準クリアで110など。上長側の達成度がランク計算に使われます。"
              onChange={(e) =>
                setKpi({
                  ...kpi,
                  achievement_rate:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
            {suggestedRate != null && (
              <span className="mission__kpiHint">実績/目標 = {suggestedRate}%</span>
            )}
          </label>
        </>
      )}
    </div>
  );
}
