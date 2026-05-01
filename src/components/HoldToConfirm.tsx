import { useEffect, useRef, useState } from "react";

const HOLD_MS = 1000;

/**
 * Press-and-hold confirmation control. Renders a button styled as a slider
 * that fills as the user holds it down; firing onConfirm only after the
 * full hold duration. Releasing early aborts.
 *
 * Used for destructive actions (delete) where we want a deliberate gesture
 * but the type-to-confirm flow felt clunky in user testing.
 */
export function HoldToConfirm({
  label,
  hint,
  onConfirm,
  onCancel,
  variant = "danger",
  autoFocus = false,
}: {
  label: string;
  hint?: string;
  onConfirm: () => void;
  onCancel?: () => void;
  variant?: "danger" | "primary";
  autoFocus?: boolean;
}) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1
  const startedAt = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const fired = useRef(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (autoFocus) btnRef.current?.focus();
  }, [autoFocus]);

  function start() {
    if (fired.current) return;
    setHolding(true);
    startedAt.current = performance.now();
    const tick = () => {
      if (startedAt.current === null) return;
      const elapsed = performance.now() - startedAt.current;
      const p = Math.min(1, elapsed / HOLD_MS);
      setProgress(p);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    timerRef.current = window.setTimeout(() => {
      if (fired.current) return;
      fired.current = true;
      cleanup();
      onConfirm();
    }, HOLD_MS);
  }

  function cancel() {
    if (fired.current) return;
    setHolding(false);
    setProgress(0);
    cleanup();
  }

  function cleanup() {
    startedAt.current = null;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  useEffect(() => cleanup, []);

  return (
    <div className="hold">
      <button
        ref={btnRef}
        type="button"
        className={`hold__btn hold__btn--${variant} ${holding ? "is-holding" : ""}`}
        onMouseDown={start}
        onMouseUp={cancel}
        onMouseLeave={cancel}
        onTouchStart={(e) => { e.preventDefault(); start(); }}
        onTouchEnd={cancel}
        onTouchCancel={cancel}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
            e.preventDefault();
            start();
          }
        }}
        onKeyUp={(e) => {
          if (e.key === "Enter" || e.key === " ") cancel();
        }}
      >
        <span
          className="hold__fill"
          style={{ width: `${progress * 100}%` }}
          aria-hidden
        />
        <span className="hold__label">
          {holding ? `離さずに保持… ${Math.ceil((1 - progress) * (HOLD_MS / 1000))}秒` : label}
        </span>
      </button>
      {hint && <p className="hold__hint">{hint}</p>}
      {onCancel && (
        <button type="button" className="btn btn--ghost btn--xs hold__cancel" onClick={onCancel}>
          キャンセル
        </button>
      )}
    </div>
  );
}
