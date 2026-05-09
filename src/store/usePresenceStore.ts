import { create } from "zustand";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase, isSupabaseConfigured } from "../lib/supabase";

export type Peer = {
  user_id: string;
  email: string;
  display_name: string | null;
  color: string;
  version_id: string | null;
  joined_at: number;
};

type PresencePayload = {
  user_id: string;
  email: string;
  display_name: string | null;
  color: string;
  version_id: string | null;
  joined_at: number;
};

type PresenceState = {
  peers: Peer[];
  channel: RealtimeChannel | null;
  selfEmail: string | null;
  subscribe: (params: {
    email: string;
    display_name: string | null;
    versionId: string | null;
  }) => Promise<void>;
  unsubscribe: () => Promise<void>;
  updateVersionId: (versionId: string | null) => Promise<void>;
};

const CHANNEL_NAME = "org-collab";

/** Stable HSL color derived from the email so a given user always lights up
 *  the same hue across sessions and clients. */
function colorFromEmail(email: string): string {
  let hash = 0;
  for (let i = 0; i < email.length; i++) {
    hash = (hash << 5) - hash + email.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 45%)`;
}

let selfPayload: PresencePayload | null = null;

export const usePresenceStore = create<PresenceState>((set, get) => ({
  peers: [],
  channel: null,
  selfEmail: null,

  subscribe: async ({ email, display_name, versionId }) => {
    if (!isSupabaseConfigured || !supabase) return;

    const existing = get().channel;
    if (existing && get().selfEmail === email) {
      // Same user already connected — just update version_id.
      await get().updateVersionId(versionId);
      return;
    }
    if (existing) {
      await existing.unsubscribe();
    }

    const myKey = email;
    const channel = supabase.channel(CHANNEL_NAME, {
      config: { presence: { key: myKey } },
    });

    selfPayload = {
      user_id: email,
      email,
      display_name,
      color: colorFromEmail(email),
      version_id: versionId,
      joined_at: Date.now(),
    };

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState<PresencePayload>();
      const peers: Peer[] = [];
      Object.entries(state).forEach(([key, presences]) => {
        if (key === myKey) return;
        for (const p of presences) {
          peers.push({
            user_id: p.user_id,
            email: p.email,
            display_name: p.display_name,
            color: p.color,
            version_id: p.version_id,
            joined_at: p.joined_at ?? 0,
          });
        }
      });
      set({ peers });
    });

    channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED" && selfPayload) {
        await channel.track(selfPayload);
      }
    });

    set({ channel, selfEmail: email });
  },

  updateVersionId: async (versionId) => {
    const ch = get().channel;
    if (!ch || !selfPayload) return;
    if (selfPayload.version_id === versionId) return;
    selfPayload = { ...selfPayload, version_id: versionId };
    await ch.track(selfPayload);
  },

  unsubscribe: async () => {
    const ch = get().channel;
    if (ch) await ch.unsubscribe();
    selfPayload = null;
    set({ channel: null, peers: [], selfEmail: null });
  },
}));
