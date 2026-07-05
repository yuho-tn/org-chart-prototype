import {
  STAGE_LABELS,
  STAGE_ORDER,
  stageIndex,
  deadlineInfo,
  type MissionStage,
  type MissionTemplateRow,
} from "../../lib/mission";

/**
 * ミッションシート系ページの共有パーツ（バッジ・締切バナー・進捗）。
 * CSS は index.css 末尾の mission__ プレフィックス群を使う。
 */

export function StageBadge({ stage }: { stage: MissionStage }) {
  return (
    <span className={`mission__stagebadge mission__stagebadge--${stage}`}>
      {STAGE_LABELS[stage]}
    </span>
  );
}

/**
 * 締切バナー:「期初目標の提出期限まであとN日」。超過は赤で「N日超過」。
 * 現フェーズに締切が設定されていなければ何も出さない。
 */
export function DeadlineBanner({
  template,
  stage,
}: {
  template: Pick<MissionTemplateRow, "deadlines"> | null | undefined;
  stage: MissionStage;
}) {
  if (!template) return null;
  const info = deadlineInfo(template, stage);
  if (!info) return null;
  const tone = info.overdue ? "overdue" : info.daysLeft <= 3 ? "warn" : "ok";
  return (
    <div className={`mission__deadline mission__deadline--${tone}`}>
      {info.overdue ? (
        <>
          ⚠ {info.phaseLabel}期限（{info.date}）を
          <strong>{Math.abs(info.daysLeft)}日超過</strong>しています
        </>
      ) : info.daysLeft === 0 ? (
        <>
          ⏰ {info.phaseLabel}期限（{info.date}）は<strong>本日締切</strong>です
        </>
      ) : (
        <>
          ⏰ {info.phaseLabel}期限（{info.date}）まであと
          <strong>{info.daysLeft}日</strong>
        </>
      )}
    </div>
  );
}

/** ステージ進捗インジケータ（発行済→…→査定確定の6段階）。 */
export function StageProgress({ stage }: { stage: MissionStage }) {
  const current = stageIndex(stage);
  return (
    <ol className="mission__progress">
      {STAGE_ORDER.map((s, i) => (
        <li
          key={s}
          className={[
            "mission__step",
            i < current ? "is-done" : "",
            i === current ? "is-current" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <span className="mission__stepDot" aria-hidden />
          <span className="mission__stepLabel">{STAGE_LABELS[s]}</span>
        </li>
      ))}
    </ol>
  );
}
