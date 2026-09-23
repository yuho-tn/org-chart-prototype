import { useEffect, useRef } from "react";

/**
 * タブ復帰（visibilitychange → visible）とウィンドウフォーカス時に
 * 再検証コールバックを呼ぶ小フック（P0-1）。
 *
 * 長時間放置 → タブ復帰でデータが古い／初回ロードがスタックしたケースの
 * 自動回復経路。連打防止に最短間隔（既定5秒）を設ける。
 * コールバックは ref 経由で常に最新を呼ぶため、呼び出し側で useCallback に
 * 包む必要はない。
 */
export function useRevalidateOnFocus(fn: () => void, minIntervalMs = 5_000) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const lastRun = useRef(0);

  useEffect(() => {
    const trigger = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRun.current < minIntervalMs) return;
      lastRun.current = now;
      fnRef.current();
    };
    document.addEventListener("visibilitychange", trigger);
    window.addEventListener("focus", trigger);
    return () => {
      document.removeEventListener("visibilitychange", trigger);
      window.removeEventListener("focus", trigger);
    };
  }, [minIntervalMs]);
}
