import { useCallback, useEffect, useRef, useState } from "react";

/**
 * パルス系ページ共通のトースト通知フック＋表示コンポーネント（設計書 v2 §3）。
 * 4秒で自動消滅・クリックで即消去・role="status" aria-live="polite" でスクリーンリーダーにも通知する。
 * 各ページの既存トーストclass（.pdash__toast / .pulse__toast）をそのまま流用できるよう
 * className をprops化している（未指定時は .pdash__toast）。
 *
 * 使い方:
 *   const { toast, showToast, clearToast } = usePulseToast();
 *   showToast("success", "集計を更新しました");
 *   <PulseToast toast={toast} onDismiss={clearToast} />
 */

export type PulseToastKind = "info" | "success" | "error";

export type PulseToastState = { kind: PulseToastKind; text: string } | null;

const AUTO_DISMISS_MS = 4_000;

export function usePulseToast() {
  const [toast, setToast] = useState<PulseToastState>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const clearToast = useCallback(() => {
    clearTimer();
    setToast(null);
  }, []);

  const showToast = useCallback((kind: PulseToastKind, text: string) => {
    clearTimer();
    setToast({ kind, text });
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setToast(null);
    }, AUTO_DISMISS_MS);
  }, []);

  // アンマウント時にタイマーが残らないようにする。
  useEffect(() => clearTimer, []);

  return { toast, showToast, clearToast };
}

export function PulseToast({
  toast,
  onDismiss,
  className = "pdash__toast",
}: {
  toast: PulseToastState;
  onDismiss: () => void;
  className?: string;
}) {
  if (!toast) return null;
  return (
    <div
      className={toast.kind === "error" ? `${className} ${className}--error` : className}
      role="status"
      aria-live="polite"
      onClick={onDismiss}
    >
      {toast.text}
    </div>
  );
}
