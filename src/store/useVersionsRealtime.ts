import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";
import type { OrgNode } from "../lib/types";
import { useOrgStore } from "./useOrgStore";
import { useVersionsStore } from "./useVersionsStore";

/**
 * Collaborative sync engine (v2, 2026-07 rewrite).
 *
 * The first implementation relied on Postgres Changes (WAL → Realtime), but
 * that pipeline turned out to be broken on the hosted project: every
 * postgres_changes subscription fails server-side with
 * `column "selected_columns" of relation "subscription" does not exist`
 * (a Realtime-internal schema drift), while the client happily reports
 * SUBSCRIBED — so nobody ever received anybody's changes. This rewrite
 * removes that dependency entirely and layers three mechanisms that only
 * need the WebSocket broadcast path (which works) plus plain REST reads:
 *
 *   1. Broadcast  — after every successful save/rename/delete/confirm the
 *      writing client broadcasts {kind, versionId} on a shared channel.
 *      Receivers re-fetch metadata and, if the touched file is the one they
 *      have open, pull the fresh snapshot via REST.
 *   2. Polling    — every POLL_MS each client compares the server's
 *      updated_at of the currently-open file against what it last applied.
 *      This is the safety net for missed broadcasts (sleeping laptop,
 *      dropped socket, writer on an old app version).
 *   3. Revalidate on focus — window focus / visibilitychange triggers an
 *      immediate check, so returning to a background tab syncs instantly.
 *
 * Conflict stance is unchanged: incoming snapshots never clobber unsaved
 * local edits. When dirty, we surface a "remote is ahead" banner and let
 * the user decide (keep editing & overwrite on save, or discard & pull).
 */

const POLL_MS = 20_000;

type ChangeKind = "saved" | "created" | "deleted" | "renamed" | "confirmed";

type ChangePayload = {
  kind: ChangeKind;
  versionId: string;
  /** Human-readable file name, for toasts on the receiving side. */
  name?: string;
  by?: string | null;
};

type State = {
  channel: RealtimeChannel | null;
  pollTimer: number | null;
  /** updated_at we last applied (or wrote) per version id. Poll compares
   *  against this to decide whether the server moved ahead of us. */
  appliedUpdatedAt: Record<string, string>;
  /** updated_at values we already warned about while dirty — avoids
   *  re-toasting the same remote save every poll tick. */
  warnedUpdatedAt: Record<string, string>;

  subscribe: () => void;
  unsubscribe: () => Promise<void>;
  /** Record our own successful write so polling doesn't re-pull it. */
  markSelfSave: (versionId: string, updatedAt?: string) => void;
  /** Notify other clients that a version changed. Fire-and-forget. */
  broadcastChange: (payload: ChangePayload) => void;
  /** Compare the open file against the server and pull if it moved. */
  checkNow: () => Promise<void>;
  /** Discard local edits and load the server's latest snapshot. */
  pullLatest: () => Promise<boolean>;
};

async function fetchVersionHead(
  versionId: string,
): Promise<{ id: string; name: string; updated_at: string | null } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from("org_versions")
    .select("id, name, updated_at")
    .eq("id", versionId)
    .maybeSingle();
  if (error || !data) return null;
  return data as { id: string; name: string; updated_at: string | null };
}

export const useVersionsRealtime = create<State>((set, get) => ({
  channel: null,
  pollTimer: null,
  appliedUpdatedAt: {},
  warnedUpdatedAt: {},

  subscribe: () => {
    if (!isSupabaseConfigured || !supabase) return;
    if (get().channel) return;

    const channel = supabase.channel("org-collab-sync", {
      config: { broadcast: { self: false } },
    });

    channel.on("broadcast", { event: "version-change" }, ({ payload }) => {
      void handleRemoteChange(payload as ChangePayload);
    });

    channel.subscribe();

    const timer = window.setInterval(() => {
      void get().checkNow();
    }, POLL_MS);

    window.addEventListener("focus", onWindowFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    set({ channel, pollTimer: timer });
  },

  unsubscribe: async () => {
    const { channel, pollTimer } = get();
    if (pollTimer !== null) window.clearInterval(pollTimer);
    window.removeEventListener("focus", onWindowFocus);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    set({ channel: null, pollTimer: null });
    if (channel) await channel.unsubscribe();
  },

  markSelfSave: (versionId, updatedAt) => {
    if (!updatedAt) return;
    set({
      appliedUpdatedAt: { ...get().appliedUpdatedAt, [versionId]: updatedAt },
    });
  },

  broadcastChange: (payload) => {
    const ch = get().channel;
    if (!ch) return;
    void ch.send({ type: "broadcast", event: "version-change", payload });
  },

  checkNow: async () => {
    const orgState = useOrgStore.getState();
    const vid = orgState.currentVersionId;
    if (!vid) return;

    const head = await fetchVersionHead(vid);
    // Re-read after the await: the user may have switched files meanwhile.
    if (useOrgStore.getState().currentVersionId !== vid) return;
    if (!head || !head.updated_at) return;

    const applied = get().appliedUpdatedAt[vid];
    if (!applied) {
      // First look at this file in this session. The snapshot we loaded came
      // from a fresh REST read moments ago, so take the server's stamp as
      // our baseline instead of re-downloading identical content.
      get().markSelfSave(vid, head.updated_at);
      return;
    }
    if (head.updated_at <= applied) return;

    await applyServerSnapshot(vid, head.name, head.updated_at);
  },

  pullLatest: async () => {
    const orgState = useOrgStore.getState();
    const vid = orgState.currentVersionId;
    if (!vid) return false;
    const head = await fetchVersionHead(vid);
    if (!head) return false;
    const ok = await applyServerSnapshot(vid, head.name, head.updated_at, {
      force: true,
    });
    return ok;
  },
}));

function onWindowFocus() {
  void useVersionsRealtime.getState().checkNow();
  // Also refresh the file list so the drawer/badges are current.
  void useVersionsStore.getState().refresh();
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") onWindowFocus();
}

async function handleRemoteChange(payload: ChangePayload) {
  const versionsState = useVersionsStore.getState();
  const orgState = useOrgStore.getState();

  // Keep the FilesDrawer / pickers current for every kind of change.
  void versionsState.refresh();

  if (!payload?.versionId) return;
  const isCurrent = orgState.currentVersionId === payload.versionId;
  if (!isCurrent) return;

  if (payload.kind === "deleted") {
    orgState.setToast({
      kind: "error",
      message:
        "開いているファイルが他のユーザーによって削除されました。新規ファイルとして編集中です。",
    });
    useOrgStore.setState({
      currentVersionId: null,
      currentVersionLabel: null,
      dirty: true,
    });
    return;
  }

  if (payload.kind === "renamed" || payload.kind === "confirmed") {
    // Metadata-only changes: refresh (above) already covers the pickers;
    // update the open file's label so the toolbar matches.
    const head = await fetchVersionHead(payload.versionId);
    if (head && useOrgStore.getState().currentVersionId === payload.versionId) {
      useOrgStore.setState({ currentVersionLabel: head.name });
    }
    return;
  }

  // kind === "saved" (or unknown → treat as content change)
  const head = await fetchVersionHead(payload.versionId);
  if (!head) return;
  if (useOrgStore.getState().currentVersionId !== payload.versionId) return;
  await applyServerSnapshot(payload.versionId, head.name, head.updated_at);
}

/**
 * Pull the snapshot for `versionId` and swap it into the editor.
 * Skips (and warns once per server revision) when there are unsaved local
 * edits, unless `force` is set (= the user explicitly chose to discard).
 */
async function applyServerSnapshot(
  versionId: string,
  name: string,
  updatedAt: string | null,
  opts?: { force?: boolean },
): Promise<boolean> {
  const rt = useVersionsRealtime.getState();
  const orgState = useOrgStore.getState();

  const applied = updatedAt ? rt.appliedUpdatedAt[versionId] : null;
  if (!opts?.force && updatedAt && applied && updatedAt <= applied) {
    return false; // already have it (e.g. broadcast + poll raced)
  }

  if (orgState.dirty && !opts?.force) {
    const stamp = updatedAt ?? "unknown";
    if (rt.warnedUpdatedAt[versionId] !== stamp) {
      useVersionsRealtime.setState({
        warnedUpdatedAt: { ...rt.warnedUpdatedAt, [versionId]: stamp },
      });
      orgState.setRemoteAhead({ versionId, name, updatedAt: stamp });
      orgState.setToast({
        kind: "info",
        message: `他のメンバーが「${name}」を更新しました。未保存の変更があるため自動反映を止めています。`,
      });
    }
    return false;
  }

  const nodes = await useVersionsStore.getState().getSnapshot(versionId);
  if (!nodes) return false;
  // The user may have navigated away while the snapshot downloaded.
  if (useOrgStore.getState().currentVersionId !== versionId) return false;

  useOrgStore.getState().replaceNodes(nodes as OrgNode[], {
    versionId,
    versionLabel: name,
  });
  useOrgStore.getState().setRemoteAhead(null);
  if (updatedAt) {
    useVersionsRealtime.getState().markSelfSave(versionId, updatedAt);
  }
  useOrgStore.getState().setToast({
    kind: "info",
    message: `他のメンバーの保存を反映しました（「${name}」）`,
  });
  return true;
}
