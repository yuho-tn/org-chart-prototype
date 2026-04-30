import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

export const supabase = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: false },
    })
  : null;

export type VersionRow = {
  id: string;
  name: string;
  author: string;
  note: string | null;
  created_at: string;
};

export type VersionWithSnapshot = VersionRow & {
  snapshot: { nodes: unknown[] };
};
