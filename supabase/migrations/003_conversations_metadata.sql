-- Migration: Add metadata jsonb column to conversations table
-- Used to persist analysis state (risk, intersection, sel, mapping, file_id, stage)
-- so cards can be restored when a teacher returns to a conversation

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Index for faster metadata queries if needed later
CREATE INDEX IF NOT EXISTS idx_conversations_metadata
  ON public.conversations USING gin (metadata);

COMMENT ON COLUMN public.conversations.metadata IS
  'Stores analysis state: file_id, mapping, stage, risk, intersection, sel results';
