import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured, type VersionRow } from "../lib/supabase";
import type { OrgNode } from "../lib/types";
import { useOrgStore } from "./useOrgStore";
import { useVersionsStore } from "./useVersionsStore";

/**
 * Phase 2 of collaborative editing: subscribe to Postgres Changes on the
 * org_versions table and reflect other users' saves into the live editor.
 * Self-originated changes are suppressed via a short echo-window after the
 * local save call (see markSelfSave below).
 */

const ECHO_WINDOW_MS = 4000;

type Inbound = VersionRow & {
  snapshot?: { nodes?: OrgNode[] } | null;
};

type State = {
  channel: RealtimeChannel | null;
  /** Marker placed by useVersionsStore right after a successful save/update.
   *  Updates to the same row arriving within ECHO_WINDOW_MS are treated as
   *  the round-trip echo of our own write and skipped — without this, every
   *  save would re-render the canvas via replaceNodes which clobbers the
   *  current selection and incidentally triggers the dirty-flag logic. */
  lastSelfSave: { versionId: string; at: number } | null;
  subscribe: () => void;
  unsubscribe: () => Promise<void>;
  markSelfSave: (versionId: string) => void;
};

function applyOtherUpdate(row: Inbound) {
  const orgState = useOrgStore.getState();
  const versionsState = useVersionsStore.getState();

  // Always refresh the metadata list so File drawer / version pickers see
  // the new updated_at, regardless of whether we apply the snapshot.
  versionsState.refresh();

  // Only auto-sync when the update is for the file currently open in our
  // editor. Updates to other files are visible via the FilesDrawer reload
  // above; they do not silently swap in.
  if (orgState.currentVersionId !== row.id) return;

  const snapshotNodes = row.snapshot?.nodes;
  if (!snapshotNodes || !Array.isArray(snapshotNodes)) return;

  if (orgState.dirty) {
    // Local has unsaved edits — refuse to clobber. Surface a toast so the
    // user knows the canvas is no longer the latest server state.
    orgState.setToast({
      kind: "info",
      message: `他のメンバーが「${row.name}」を更新しました。未保存の変更があるため自動反映はスキップしました（保存または破棄後に反映されます）。`,
    });
    return;
  }

  orgState.replaceNodes(snapshotNodes, {
    versionId: row.id,
    versionLabel: row.name,
  });
  orgState.setToast({
    kind: "info",
    message: `他のメンバーの保存を反映しました（「${row.name}」）`,
  });
}

export const useVersionsRealtime = create<State>((set, get) => ({
  channel: null,
  lastSelfSave: null,

  subscribe: () => {
    if (!isSupabaseConfigured || !supabase) return;
    if (get().channel) return;

    const channel = supabase.channel("org-versions-changes");

    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "org_versions" },
      (payload) => {
        const newRow = payload.new as Inbound;
        const last = get().lastSelfSave;
        const isEcho =
          last &&
          last.versionId === newRow.id &&
          Date.now() - last.at < ECHO_WINDOW_MS;
        if (isEcho) {
          // Still refresh the versions list so badges (updated_at) stay current.
          useVersionsStore.getState().refresh();
          return;
        }
        applyOtherUpdate(newRow);
      },
    );

    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "org_versions" },
      () => {
        // New file created by someone — pull metadata so it appears in the
        // FilesDrawer. We don't auto-open it.
        useVersionsStore.getState().refresh();
      },
    );

    channel.on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "org_versions" },
      (payload) => {
        const oldRow = payload.old as Partial<VersionRow>;
        const orgState = useOrgStore.getState();
        // Refresh metadata in any case
        useVersionsStore.getState().refresh();
        // If the open file got deleted out from under us, warn the user.
        if (oldRow?.id && orgState.currentVersionId === oldRow.id) {
          orgState.setToast({
            kind: "error",
            message: "開いているファイルが他のユーザーによって削除されました。新規ファイルとして編集中です。",
          });
          // Detach from server-side version so subsequent saves create a new row.
          useOrgStore.setState({
            currentVersionId: null,
            currentVersionLabel: null,
            dirty: true,
          });
        }
      },
    );

    channel.subscribe();
    set({ channel });
  },

  unsubscribe: async () => {
    const ch = get().channel;
    if (ch) await ch.unsubscribe();
    set({ channel: null });
  },

  markSelfSave: (versionId) => {
    set({ lastSelfSave: { versionId, at: Date.now() } });
  },
}));
