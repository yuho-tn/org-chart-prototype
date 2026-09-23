import { aiLevelDef, AI_LEVEL_KIND_LABEL, type AiLevelKind } from "../../lib/aiLevels";

/**
 * AI活用レベルの称号バッジ。
 *   size="sm" — メンバーギャラリーの MBTI/資質バッジの並び用（L4 BUILDER）
 *   size="md" — 詳細ページ・ダッシュボード用（L4 BUILDER ＋ 仮認定チップ）
 * L5 以上は solid（濃地×白文字）で格を出す（lib/aiLevels のカラー定義）。
 */
export function AiLevelBadge({
  level,
  kind,
  size = "sm",
}: {
  level: number;
  kind?: AiLevelKind;
  size?: "sm" | "md";
}) {
  const def = aiLevelDef(level);
  if (!def) return null;
  const { color } = def;
  const style = def.color.solid
    ? { background: color.main, borderColor: color.main, color: color.text }
    : { background: color.soft, borderColor: color.main, color: color.text };
  return (
    <span
      className={`ailbadge ailbadge--${size}`}
      style={style}
      title={`L${def.level} ${def.code}（${def.subcopy}）— ${def.definition}`}
    >
      <span className="ailbadge__lv">L{def.level}</span>
      <span className="ailbadge__code">{def.code}</span>
      {size === "md" && kind === "provisional" && (
        <span className="ailbadge__kind">{AI_LEVEL_KIND_LABEL[kind]}</span>
      )}
    </span>
  );
}

export default AiLevelBadge;
