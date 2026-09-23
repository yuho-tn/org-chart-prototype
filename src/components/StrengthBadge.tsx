import { useEffect, useId, useRef, useState } from "react";
import {
  STRENGTH_DOMAIN_COLOR,
  STRENGTH_DOMAIN_LABEL,
  strengthDetailText,
  type StrengthQuality,
} from "../lib/strengths";

const openListeners = new Set<(instanceId: string) => void>();

function announceOpen(instanceId: string) {
  for (const listener of openListeners) listener(instanceId);
}

type StrengthBadgeProps = {
  quality: StrengthQuality;
  rank?: number;
  compact?: boolean;
};

export function StrengthBadge({ quality, rank, compact = false }: StrengthBadgeProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const instanceId = useId();
  const popoverId = `strength-popover-${instanceId.replace(/:/g, "")}`;
  const color = STRENGTH_DOMAIN_COLOR[quality.domain];

  useEffect(() => {
    const closeOther = (openedId: string) => {
      if (openedId !== instanceId) setOpen(false);
    };
    openListeners.add(closeOther);
    return () => {
      openListeners.delete(closeOther);
    };
  }, [instanceId]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    if (next) announceOpen(instanceId);
    setOpen(next);
  };

  return (
    <span
      ref={rootRef}
      className={`strengthBadgeWrap${compact ? " strengthBadgeWrap--compact" : ""}`}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
    >
      <span
        className={`strengthBadge${compact ? " strengthBadge--compact" : ""}`}
        style={{ background: color }}
        title={quality.description}
      >
        {rank !== undefined && <span className="strengthBadge__rank">{rank}</span>}
        <span className="strengthBadge__name">{quality.name_ja}</span>
        <button
          type="button"
          className="strengthBadge__q"
          aria-label={`${quality.name_ja}の説明を見る`}
          aria-expanded={open}
          aria-controls={popoverId}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          ?
        </button>
      </span>
      {open && (
        <span
          id={popoverId}
          className="strengthBadge__popover"
          role="dialog"
          aria-label={`${quality.name_ja}の詳細説明`}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="strengthBadge__popoverHead">
            <span>
              <strong className="strengthBadge__popoverName">{quality.name_ja}</strong>
              <span className="strengthBadge__popoverEnglish">{quality.name_en}</span>
            </span>
            <span className="strengthBadge__popoverDomain">
              <span
                className="strengthBadge__popoverDot"
                style={{ background: color }}
                aria-hidden="true"
              />
              {STRENGTH_DOMAIN_LABEL[quality.domain]}
            </span>
          </span>
          <span className="strengthBadge__popoverQuote">
            <span className="strengthBadge__popoverBody">{strengthDetailText(quality)}</span>
            {quality.detail_en && (
              <span className="strengthBadge__popoverBodyEn" lang="en">
                {quality.detail_en}
              </span>
            )}
          </span>
          {quality.detail_url && (
            <a
              className="strengthBadge__popoverSource"
              href={quality.detail_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => event.stopPropagation()}
            >
              出典：{quality.detail_source ?? "公式サイト"} ↗
            </a>
          )}
        </span>
      )}
    </span>
  );
}
