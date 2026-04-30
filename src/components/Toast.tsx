import { useEffect } from "react";
import { useOrgStore } from "../store/useOrgStore";

export function Toast() {
  const toast = useOrgStore((s) => s.toast);
  const setToast = useOrgStore((s) => s.setToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  if (!toast) return null;
  return <div className={`toast toast--${toast.kind}`}>{toast.message}</div>;
}
