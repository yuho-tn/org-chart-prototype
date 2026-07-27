import { create } from "zustand";
import { supabase } from "../lib/supabase";
import { useAuthStore } from "./useAuthStore";
import { useVersionsRealtime } from "./useVersionsRealtime";
import { useOrgStore } from "./useOrgStore";

/**
 * P2: 組織図ファイルの編集ロック（要件定義書 §6-1）。
 *
 * 1ファイル1編集者。開くと自動でロック取得を試み、取れなければ閲覧モード
 * （誰が編集中か表示・admin以上は強制引継ぎ可）。サーバ側は
 * org_edit_locks + SECURITY DEFINER RPC（0027）で、heartbeat が90秒
 * 途絶えたロックは stale として奪取可能。
 *
 * mode:
 *   - "edit" … 通常。ファイルを開いたらロック取得を試みる
 *   - "view" … #/org の公式デフォルト表示など、ロックを取らない閲覧。
 *               TopBar の「編集する」で edit へ昇格する
 */

const HEARTBEAT_MS = 30_000;
const WATCH_MS = 15_000;
const STALE_MS = 90_000;

type LockMode = "edit" | "view";

type OrgLockState = {
  versionId: string | null;
  mode: LockMode;
  /** 生きているロックの保持者 email（自分含む）。null = ロックなし。 */
  holder: string | null;
  mine: boolean;

  setMode: (mode: LockMode) => void;
  /** ファイルを開いた時に呼ぶ。ロック取得を試み、heartbeat / 監視を開始。 */
  attach: (versionId: string) => Promise<void>;
  /** ファイルを離れる時に呼ぶ。自分のロックを解放しタイマー停止。 */
  detach: () => Promise<void>;
  /** サーバのロック状態を再取得（stale は「ロックなし」扱い）。 */
  refreshState: () => Promise<void>;
  /** ロック再試行（閲覧モードからの再取得）。 */
  tryAcquire: () => Promise<boolean>;
  /** 強制引継ぎ（admin 以上）。 */
  steal: () => Promise<boolean>;
};

let heartbeatTimer: number | null = null;
let watchTimer: number | null = null;
let pagehideBound = false;

function myEmail(): string | null {
  return useAuthStore.getState().currentUser?.email?.toLowerCase() ?? null;
}

function isWriterRole(): boolean {
  const role = useAuthStore.getState().currentUser?.role;
  return (
    role === "master" ||
    role === "privileged_admin" ||
    role === "admin" ||
    role === "editor"
  );
}

function clearTimers() {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
}

/** タブ破棄時のベストエフォート解放（確実性は stale 90秒判定が担保）。 */
function releaseByBeacon() {
  const st = useOrgLock.getState();
  if (!st.versionId || !st.mine || !supabase) return;
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !key) return;
  // localStorage の supabase セッションから access_token を拾う
  try {
    const tokenKey = Object.keys(localStorage).find(
      (k) => k.startsWith("sb-") && k.endsWith("-auth-token"),
    );
    if (!tokenKey) return;
    const raw = localStorage.getItem(tokenKey);
    if (!raw) return;
    const token = (JSON.parse(raw) as { access_token?: string }).access_token;
    if (!token) return;
    void fetch(`${url}/rest/v1/rpc/org_lock_release`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_version_id: st.versionId }),
    });
  } catch {
    // ignore — stale 判定に任せる
  }
}

function startHeartbeat() {
  clearTimers();
  heartbeatTimer = window.setInterval(async () => {
    const st = useOrgLock.getState();
    if (!st.versionId || !st.mine || !supabase) return;
    const { data, error } = await supabase.rpc("org_lock_heartbeat", {
      p_version_id: st.versionId,
    });
    if (error) return; // 一時的な失敗は次の周期に任せる（stale 猶予90秒）
    if (data !== true) {
      // ロックを失った（強制引継ぎ等）→ 閲覧モードへ降格
      useOrgLock.setState({ mine: false });
      await useOrgLock.getState().refreshState();
      const holder = useOrgLock.getState().holder;
      useOrgStore.getState().setToast({
        kind: "error",
        message: holder
          ? `編集権限が ${holder} さんに移りました（閲覧モード）`
          : "編集ロックが解除されました。再度「編集を再開」してください。",
      });
      startWatch();
    }
  }, HEARTBEAT_MS);
}

function startWatch() {
  clearTimers();
  watchTimer = window.setInterval(async () => {
    const st = useOrgLock.getState();
    if (!st.versionId || st.mine) return;
    await st.refreshState();
    // ロックが空いたら自動再取得（先勝ち・RPC側で直列化される）
    if (!useOrgLock.getState().holder && isWriterRole()) {
      const ok = await useOrgLock.getState().tryAcquire();
      if (ok) {
        useOrgStore.getState().setToast({
          kind: "info",
          message: "編集ロックを取得しました。編集できます。",
        });
      }
    }
  }, WATCH_MS);
}

export const useOrgLock = create<OrgLockState>((set, get) => ({
  versionId: null,
  mode: "edit",
  holder: null,
  mine: false,

  setMode: (mode) => set({ mode }),

  attach: async (versionId) => {
    if (get().versionId === versionId && (get().mine || get().holder)) return;
    if (get().versionId && get().versionId !== versionId) await get().detach();
    set({ versionId, holder: null, mine: false });

    if (!pagehideBound) {
      window.addEventListener("pagehide", releaseByBeacon);
      pagehideBound = true;
    }

    if (!isWriterRole()) {
      // 保存権限がないユーザーはロックを取らず、状態表示だけ。
      await get().refreshState();
      return;
    }
    const ok = await get().tryAcquire();
    if (!ok) startWatch();
  },

  detach: async () => {
    const { versionId, mine } = get();
    clearTimers();
    set({ versionId: null, holder: null, mine: false });
    if (versionId && mine && supabase) {
      await supabase.rpc("org_lock_release", { p_version_id: versionId });
      useVersionsRealtime.getState().broadcastChange({
        kind: "lock",
        versionId,
      });
    }
  },

  refreshState: async () => {
    const { versionId } = get();
    if (!versionId || !supabase) return;
    const { data, error } = await supabase
      .from("org_edit_locks")
      .select("locked_by_email, heartbeat_at")
      .eq("version_id", versionId)
      .maybeSingle();
    if (get().versionId !== versionId) return; // 切替済み
    if (error) return;
    if (!data) {
      set({ holder: null, mine: false });
      return;
    }
    const row = data as { locked_by_email: string; heartbeat_at: string };
    const stale = Date.now() - new Date(row.heartbeat_at).getTime() > STALE_MS;
    if (stale) {
      set({ holder: null, mine: false });
      return;
    }
    set({
      holder: row.locked_by_email,
      mine: row.locked_by_email === myEmail(),
    });
  },

  tryAcquire: async () => {
    const { versionId } = get();
    if (!versionId || !supabase) return false;
    const { data, error } = await supabase.rpc("org_lock_acquire", {
      p_version_id: versionId,
    });
    if (get().versionId !== versionId) return false;
    if (error) {
      // 0027 未適用（RPC不存在）→ ロック機構なしの従来動作で編集継続
      if (/does not exist|Could not find the function/i.test(error.message)) {
        set({ holder: null, mine: false });
        return true;
      }
      return false;
    }
    const res = (data ?? {}) as { ok?: boolean; locked_by?: string };
    if (res.ok) {
      set({ holder: myEmail(), mine: true });
      startHeartbeat();
      useVersionsRealtime.getState().broadcastChange({
        kind: "lock",
        versionId,
      });
      return true;
    }
    set({ holder: res.locked_by ?? null, mine: false });
    startWatch();
    return false;
  },

  steal: async () => {
    const { versionId } = get();
    if (!versionId || !supabase) return false;
    const { data, error } = await supabase.rpc("org_lock_steal", {
      p_version_id: versionId,
    });
    if (error) return false;
    const res = (data ?? {}) as { ok?: boolean };
    if (!res.ok) return false;
    set({ holder: myEmail(), mine: true });
    startHeartbeat();
    useVersionsRealtime.getState().broadcastChange({
      kind: "lock",
      versionId,
    });
    return true;
  },
}));

/** 閲覧モードか（デフォルト表示 or 他人がロック保持）。Canvas / TopBar が参照。 */
export function selectLockReadOnly(s: OrgLockState): boolean {
  return s.mode === "view" || (!!s.holder && !s.mine);
}
