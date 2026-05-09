-- Enable Postgres Changes Realtime broadcasts for org_versions so connected
-- clients receive INSERT/UPDATE/DELETE events live. This powers the
-- "他メンバーの保存を自動反映" experience (Phase 2 of collaborative editing).
--
-- The Supabase project ships with a single shared publication named
-- supabase_realtime. Adding our table to it is a one-shot operation, and
-- duplicate ADD TABLE raises an error, so guard with IF NOT EXISTS via
-- pg_publication_tables.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'org_versions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.org_versions;
  END IF;
END $$;

-- Switch REPLICA IDENTITY to FULL so DELETE events carry the full old row
-- (we use it to remove the entry from the in-memory versions list when
-- another user deletes a file). Without FULL, payload.old only contains
-- the primary key, which is enough for our delete handler but FULL is
-- generally safer for any future "previous values" logic.
ALTER TABLE public.org_versions REPLICA IDENTITY FULL;
