import { useEffect, useState } from "react";
import { useMissionsStore, periodLabel } from "../../store/useMissionsStore";
import { useProfilesStore } from "../../store/useProfilesStore";
import { useOrgStore } from "../../store/useOrgStore";
import { useUiStore } from "../../store/useUiStore";
import type { PeriodCode } from "../../lib/supabase";
import {
  questionRespondent,
  type MissionDeadlines,
  type MissionDefinition,
  type MissionPhase,
  type MissionQuestion,
  type MissionSection,
  type QuestionRespondent,
  type QuestionType,
} from "../../lib/mission";
import { ConfirmDialog } from "../ConfirmDialog";

const TYPE_LABEL: Record<QuestionType, string> = {
  heading: "見出し（回答なし）",
  text: "テキスト（1行）",
  textarea: "テキスト（複数行）",
  select: "選択式",
  number: "数値",
  kpi_goal: "KPI目標",
};

const PHASE_LABEL: Record<MissionPhase, string> = {
  goal: "期初（goal）",
  mid: "中間（mid）",
  final: "期末（final）",
};

const RESPONDENT_LABEL: Record<QuestionRespondent, string> = {
  self: "本人",
  evaluator: "上長評価",
  both: "本人＋上長評価",
};

function newQuestionId(): string {
  return `q_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function newSectionId(): string {
  return `sec_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (to < 0 || to >= arr.length) return arr;
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * #/missions/templates/:id — テンプレート編集（mission.manage のみ）。
 * draft のみ編集可。published / archived は読み取り専用表示。
 * 設問 ID は自動採番の安定 ID — 発行後の回答は question_id で紐づくため
 * 編集 UI からは変更させない。
 */
export function MissionTemplateEditorPage({ id }: { id: string }) {
  const templates = useMissionsStore((s) => s.templates);
  const periods = useMissionsStore((s) => s.periods);
  const loaded = useMissionsStore((s) => s.loaded);
  const error = useMissionsStore((s) => s.error);
  const refresh = useMissionsStore((s) => s.refresh);
  const saveTemplate = useMissionsStore((s) => s.saveTemplate);
  const publishTemplate = useMissionsStore((s) => s.publishTemplate);

  const profilesLoaded = useProfilesStore((s) => s.loaded);
  const refreshProfiles = useProfilesStore((s) => s.refresh);
  const can = useProfilesStore((s) => s.can);
  const setToast = useOrgStore((s) => s.setToast);
  const navigate = useUiStore((s) => s.navigate);

  useEffect(() => {
    if (!loaded) refresh();
    if (!profilesLoaded) refreshProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const template = templates.find((t) => t.id === id) ?? null;
  const canManage = can("mission", "manage");
  const editable = !!template && template.status === "draft" && canManage;

  // 編集ドラフト（テンプレがロードされたら1回だけ初期化）
  const [title, setTitle] = useState("");
  const [period, setPeriod] = useState<string>("");
  const [deadlines, setDeadlines] = useState<MissionDeadlines>({});
  const [definition, setDefinition] = useState<MissionDefinition>({ sections: [] });
  const [initializedId, setInitializedId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  // テンプレがロードされたらドラフトを初期化する。「前回レンダーとの差分で
  // レンダー中に setState する」React 公式の derived-state パターン
  // （effect 内 setState はカスケード再レンダーになるため使わない）。
  if (template && initializedId !== template.id) {
    setTitle(template.title);
    setPeriod(template.period);
    setDeadlines(template.deadlines ?? {});
    setDefinition(template.definition);
    setInitializedId(template.id);
    setDirty(false);
  }

  function touch<T>(setter: (v: T) => void) {
    return (v: T) => {
      setter(v);
      setDirty(true);
    };
  }

  const setTitleD = touch(setTitle);
  const setPeriodD = touch(setPeriod);
  const setDeadlinesD = touch(setDeadlines);
  const setDefinitionD = touch(setDefinition);

  // ── セクション / 設問の操作 ──
  function updateSection(idx: number, patch: Partial<MissionSection>) {
    setDefinitionD({
      sections: definition.sections.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
    });
  }
  function addSection() {
    setDefinitionD({
      sections: [
        ...definition.sections,
        { id: newSectionId(), title: "新しいセクション", questions: [] },
      ],
    });
  }
  function removeSection(idx: number) {
    setDefinitionD({ sections: definition.sections.filter((_, i) => i !== idx) });
  }
  function moveSection(idx: number, dir: -1 | 1) {
    setDefinitionD({ sections: moveItem(definition.sections, idx, idx + dir) });
  }
  function addQuestion(secIdx: number) {
    updateSection(secIdx, {
      questions: [
        ...definition.sections[secIdx].questions,
        {
          id: newQuestionId(),
          label: "新しい設問",
          type: "textarea",
          respondent: "self",
          phase: "goal",
        },
      ],
    });
  }
  function updateQuestion(secIdx: number, qIdx: number, patch: Partial<MissionQuestion>) {
    updateSection(secIdx, {
      questions: definition.sections[secIdx].questions.map((q, i) =>
        i === qIdx ? { ...q, ...patch } : q,
      ),
    });
  }
  function removeQuestion(secIdx: number, qIdx: number) {
    updateSection(secIdx, {
      questions: definition.sections[secIdx].questions.filter((_, i) => i !== qIdx),
    });
  }
  function moveQuestion(secIdx: number, qIdx: number, dir: -1 | 1) {
    updateSection(secIdx, {
      questions: moveItem(definition.sections[secIdx].questions, qIdx, qIdx + dir),
    });
  }

  async function handleSave(): Promise<boolean> {
    if (!template) return false;
    setSaving(true);
    const res = await saveTemplate({
      id: template.id,
      period: (period || template.period) as PeriodCode,
      title: title.trim() || template.title,
      definition,
      deadlines,
      status: template.status,
      calc_version: template.calc_version,
    });
    setSaving(false);
    if (!res.ok) {
      setToast({ kind: "error", message: res.reason ?? "保存に失敗しました" });
      return false;
    }
    setDirty(false);
    setToast({ kind: "info", message: "テンプレートを保存しました" });
    return true;
  }

  async function handlePublish() {
    if (!template) return;
    setConfirmPublish(false);
    // 未保存の編集を先に保存してから公開する
    if (dirty) {
      const ok = await handleSave();
      if (!ok) return;
    }
    const res = await publishTemplate(template.id);
    setToast(
      res.ok
        ? { kind: "info", message: "テンプレートを公開しました（以後編集不可）" }
        : { kind: "error", message: res.reason ?? "公開に失敗しました" },
    );
  }

  if (loaded && !canManage) {
    return (
      <main className="page">
        <p className="versions__error">このページを表示する権限がありません（mission.manage が必要です）。</p>
      </main>
    );
  }

  if (loaded && !template) {
    return (
      <main className="page">
        <p className="versions__error">テンプレートが見つかりません。</p>
        <button className="btn btn--ghost" onClick={() => navigate({ name: "mission_templates" })}>
          ← テンプレート一覧へ
        </button>
      </main>
    );
  }

  if (!template) {
    return (
      <main className="page">
        <p className="empdetail__empty">読み込み中…</p>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">
            テンプレート{editable ? "編集" : "表示"}
            {!editable && (
              <span className={`mission__statusbadge mission__statusbadge--${template.status}`} style={{ marginLeft: 8 }}>
                {template.status === "published" ? "公開中（編集不可）" : "アーカイブ"}
              </span>
            )}
          </h1>
          <p className="page__subtitle">
            {periodLabel(template.period, periods)}｜設問 ID は発行後の回答と紐づくため自動採番・変更不可です。
          </p>
        </div>
        <div className="page__actions">
          <button className="btn btn--ghost" onClick={() => navigate({ name: "mission_templates" })}>
            ← 一覧へ
          </button>
          <button className="btn btn--ghost" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "編集に戻る" : "プレビュー"}
          </button>
          {editable && (
            <>
              <button className="btn btn--primary" disabled={saving || !dirty} onClick={handleSave}>
                {saving ? "保存中…" : dirty ? "保存" : "保存済み"}
              </button>
              <button className="btn btn--primary" onClick={() => setConfirmPublish(true)}>
                公開する
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="versions__error">{error}</p>}

      {showPreview ? (
        <TemplatePreview definition={definition} />
      ) : (
        <>
          {/* ── 基本情報 ── */}
          <div className="mission__editorMeta">
            <label className="mission__metaField">
              テンプレート名
              <input
                className="field__input"
                value={title}
                disabled={!editable}
                onChange={(e) => setTitleD(e.target.value)}
              />
            </label>
            <label className="mission__metaField">
              期
              <select
                className="field__input"
                value={period}
                disabled={!editable}
                onChange={(e) => setPeriodD(e.target.value)}
              >
                {periods.map((p) => (
                  <option key={p.code} value={p.code}>
                    {periodLabel(p.code, periods)}
                  </option>
                ))}
              </select>
            </label>
            <label className="mission__metaField">
              期初目標の提出期限
              <input
                className="field__input"
                type="date"
                value={deadlines.goal ?? ""}
                disabled={!editable}
                onChange={(e) => setDeadlinesD({ ...deadlines, goal: e.target.value || undefined })}
              />
            </label>
            <label className="mission__metaField">
              中間振り返りの期限
              <input
                className="field__input"
                type="date"
                value={deadlines.mid ?? ""}
                disabled={!editable}
                onChange={(e) => setDeadlinesD({ ...deadlines, mid: e.target.value || undefined })}
              />
            </label>
            <label className="mission__metaField">
              期末評価の期限
              <input
                className="field__input"
                type="date"
                value={deadlines.final ?? ""}
                disabled={!editable}
                onChange={(e) => setDeadlinesD({ ...deadlines, final: e.target.value || undefined })}
              />
            </label>
          </div>

          {/* ── セクション編集 ── */}
          {definition.sections.map((sec, secIdx) => (
            <div key={sec.id} className="mission__editorSection">
              <div className="mission__editorSectionHead">
                <input
                  className="field__input mission__editorSectionTitle"
                  value={sec.title}
                  disabled={!editable}
                  placeholder="セクション名"
                  onChange={(e) => updateSection(secIdx, { title: e.target.value })}
                />
                {editable && (
                  <span className="mission__editorRowBtns">
                    <button className="btn btn--ghost btn--xs" title="上へ" disabled={secIdx === 0} onClick={() => moveSection(secIdx, -1)}>↑</button>
                    <button className="btn btn--ghost btn--xs" title="下へ" disabled={secIdx === definition.sections.length - 1} onClick={() => moveSection(secIdx, 1)}>↓</button>
                    <button className="btn btn--ghost btn--xs" onClick={() => removeSection(secIdx)}>削除</button>
                  </span>
                )}
              </div>
              <input
                className="field__input field__input--xs"
                style={{ width: "100%", marginBottom: 8 }}
                value={sec.description ?? ""}
                disabled={!editable}
                placeholder="セクション説明（任意）"
                onChange={(e) => updateSection(secIdx, { description: e.target.value || undefined })}
              />

              {sec.questions.map((q, qIdx) => (
                <div key={q.id} className="mission__editorQ">
                  <div className="mission__editorQHead">
                    <code className="mission__qid" title="設問ID（発行後不変）">{q.id}</code>
                    {editable && (
                      <span className="mission__editorRowBtns">
                        <button className="btn btn--ghost btn--xs" title="上へ" disabled={qIdx === 0} onClick={() => moveQuestion(secIdx, qIdx, -1)}>↑</button>
                        <button className="btn btn--ghost btn--xs" title="下へ" disabled={qIdx === sec.questions.length - 1} onClick={() => moveQuestion(secIdx, qIdx, 1)}>↓</button>
                        <button className="btn btn--ghost btn--xs" onClick={() => removeQuestion(secIdx, qIdx)}>削除</button>
                      </span>
                    )}
                  </div>
                  <input
                    className="field__input"
                    style={{ width: "100%" }}
                    value={q.label}
                    disabled={!editable}
                    placeholder="設問文"
                    onChange={(e) => updateQuestion(secIdx, qIdx, { label: e.target.value })}
                  />
                  <div className="mission__editorQGrid">
                    <label>
                      タイプ
                      <select
                        className="field__input field__input--xs"
                        value={q.type}
                        disabled={!editable}
                        onChange={(e) => {
                          const type = e.target.value as QuestionType;
                          // heading は回答を持たない（required 不可）
                          updateQuestion(secIdx, qIdx, {
                            type,
                            ...(type === "heading" ? { required: undefined } : {}),
                          });
                        }}
                      >
                        {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
                          <option key={t} value={t}>{TYPE_LABEL[t]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      フェーズ
                      <select
                        className="field__input field__input--xs"
                        value={q.phase ?? "goal"}
                        disabled={!editable}
                        onChange={(e) => updateQuestion(secIdx, qIdx, { phase: e.target.value as MissionPhase })}
                      >
                        {(Object.keys(PHASE_LABEL) as MissionPhase[]).map((p) => (
                          <option key={p} value={p}>{PHASE_LABEL[p]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      記入者
                      <select
                        className="field__input field__input--xs"
                        value={q.respondent ?? "self"}
                        disabled={!editable}
                        onChange={(e) => updateQuestion(secIdx, qIdx, { respondent: e.target.value as QuestionRespondent })}
                      >
                        {(Object.keys(RESPONDENT_LABEL) as QuestionRespondent[]).map((r) => (
                          <option key={r} value={r}>{RESPONDENT_LABEL[r]}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      ウエイト
                      <input
                        className="field__input field__input--xs"
                        type="number"
                        value={q.weight ?? ""}
                        disabled={!editable}
                        onChange={(e) =>
                          updateQuestion(secIdx, qIdx, {
                            weight: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </label>
                    <label className="payroll-checkbox" style={{ alignSelf: "end" }}>
                      <input
                        type="checkbox"
                        checked={!!q.required}
                        disabled={!editable || q.type === "heading"}
                        onChange={(e) => updateQuestion(secIdx, qIdx, { required: e.target.checked || undefined })}
                      />
                      必須
                    </label>
                    <label className="payroll-checkbox" style={{ alignSelf: "end" }} title="アタリマエ項目（✕→強制C・第2弾計算用）">
                      <input
                        type="checkbox"
                        checked={!!q.is_fundamental}
                        disabled={!editable}
                        onChange={(e) => updateQuestion(secIdx, qIdx, { is_fundamental: e.target.checked || undefined })}
                      />
                      アタリマエ
                    </label>
                  </div>
                  <input
                    className="field__input field__input--xs"
                    style={{ width: "100%" }}
                    value={q.help ?? ""}
                    disabled={!editable}
                    placeholder="補足説明（任意）"
                    onChange={(e) => updateQuestion(secIdx, qIdx, { help: e.target.value || undefined })}
                  />
                  {q.type === "select" && (
                    <textarea
                      className="field__input field__input--xs"
                      style={{ width: "100%" }}
                      rows={3}
                      value={(q.choices ?? []).join("\n")}
                      disabled={!editable}
                      placeholder={"選択肢（1行に1つ）"}
                      onChange={(e) =>
                        updateQuestion(secIdx, qIdx, {
                          choices: e.target.value
                            .split("\n")
                            .map((c) => c.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  )}
                </div>
              ))}

              {editable && (
                <button className="btn btn--ghost btn--xs" onClick={() => addQuestion(secIdx)}>
                  ＋設問を追加
                </button>
              )}
            </div>
          ))}

          {editable && (
            <button className="btn btn--ghost" style={{ marginTop: 8 }} onClick={addSection}>
              ＋セクションを追加
            </button>
          )}
        </>
      )}

      {confirmPublish && (
        <ConfirmDialog
          title="テンプレートを公開する"
          message={
            <>
              公開すると<strong>テンプレートの内容（設問・締切・期）は以後編集できません</strong>。
              未保存の編集は保存してから公開されます。よろしいですか？
            </>
          }
          confirmLabel="公開する"
          onConfirm={handlePublish}
          onCancel={() => setConfirmPublish(false)}
        />
      )}
    </main>
  );
}

// ── プレビュー（読み取り専用の見た目確認） ──────────────────────────────

function TemplatePreview({ definition }: { definition: MissionDefinition }) {
  return (
    <div className="mission__preview">
      {definition.sections.map((sec) => (
        <div key={sec.id} className="mission__section">
          <h3 className="mission__sectionTitle">{sec.title}</h3>
          {sec.description && <p className="mission__sectionDesc">{sec.description}</p>}
          {sec.questions.map((q) => {
            if (q.type === "heading") {
              return <h4 key={q.id} className="mission__qheading">{q.label}</h4>;
            }
            const resp = questionRespondent(q);
            return (
              <div key={q.id} className="mission__q">
                <div className="mission__qlabel">
                  {q.label}
                  {q.required && <span className="mission__required">＊必須</span>}
                  <span className="mission__qmeta">
                    {TYPE_LABEL[q.type]}／{PHASE_LABEL[q.phase ?? "goal"]}／{RESPONDENT_LABEL[resp]}
                  </span>
                </div>
                {q.help && <p className="mission__qhelp">{q.help}</p>}
                {q.type === "select" ? (
                  <select className="field__input" disabled>
                    {(q.choices ?? []).map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                ) : q.type === "kpi_goal" ? (
                  <div className="mission__kpi">
                    <input className="field__input field__input--xs" disabled placeholder="目標名" />
                    <input className="field__input field__input--xs" disabled placeholder="指標" />
                    <input className="field__input field__input--xs" disabled placeholder="目標値" />
                    <input className="field__input field__input--xs" disabled placeholder="単位" />
                  </div>
                ) : q.type === "number" ? (
                  <input className="field__input" type="number" disabled placeholder="数値" />
                ) : q.type === "text" ? (
                  <input className="field__input" disabled placeholder="回答（1行）" />
                ) : (
                  <textarea className="field__input" rows={3} disabled placeholder="回答（複数行）" />
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
