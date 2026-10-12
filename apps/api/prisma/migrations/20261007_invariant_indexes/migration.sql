-- Partial and expression indexes that back the public browse surface and the
-- review queue.
--
-- These live in a migration rather than in invariants.sql on purpose. Prisma's
-- drift detection compares the database against the migration history, so an
-- index created outside a migration makes `prisma migrate dev` demand a reset
-- on every run. Triggers and functions stay in invariants.sql because Prisma does
-- not manage those at all and therefore never reports them as drift.

-- Live listings of a kind, in a state, cheapest-first within a price band.
CREATE INDEX IF NOT EXISTS idx_listings_public_browse
  ON listings (kind_code, state_code, price)
  WHERE status = 'LIVE';

CREATE INDEX IF NOT EXISTS idx_listings_public_recent
  ON listings (kind_code, published_at DESC)
  WHERE status = 'LIVE';

-- Fuzzy title matching for the search box.
CREATE INDEX IF NOT EXISTS idx_listings_title_trgm
  ON listings USING gin (title_norm gin_trgm_ops);

-- Unaccented, case-insensitive area name matching for autocomplete.
CREATE INDEX IF NOT EXISTS idx_areas_norm_trgm
  ON areas USING gin (norm_name gin_trgm_ops);

-- Pending review queue ordered by SLA urgency.
CREATE INDEX IF NOT EXISTS idx_listings_review_queue
  ON listings (sla_due_at)
  WHERE status = 'PENDING_REVIEW';

-- Active OTP fallback sweep: only rows the timer still has work to do.
CREATE INDEX IF NOT EXISTS idx_otp_fallback_sweep
  ON otp_challenges (sms_fallback_due_at)
  WHERE status = 'SENT' AND sms_fallback_sent_at IS NULL;

-- Abuse detection: one account revealing across many listings in a short window.
CREATE INDEX IF NOT EXISTS idx_reveals_anomaly
  ON contact_reveals (viewer_id, revealed_at DESC);
