-- Per-message delivery receipt.
--
-- `sent` is `created_at`, which always exists. `seen` is derived from the
-- conversation-level read marker in `message_reads`, so it needs no column of
-- its own: a message is seen when it was created at or before the reader's
-- `last_read_at`.
--
-- `delivered` needs a column because it is a distinct fact from both: the
-- recipient's client has the message on screen but has not opened it. It is
-- written once, by the recipient's own fetch, and never rewritten, so the
-- WHERE clause below is naturally idempotent and cheap.
--
-- Deliberately no `seen_at` column. Duplicating a fact the read marker already
-- holds invites the two to disagree.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;

-- Supports the single write this column exists for: "mark everything from the
-- other party that has not been delivered yet". Without it that UPDATE scans
-- the conversation's messages.
CREATE INDEX IF NOT EXISTS messages_undelivered_idx
  ON messages (conversation_id, sender_id)
  WHERE delivered_at IS NULL;