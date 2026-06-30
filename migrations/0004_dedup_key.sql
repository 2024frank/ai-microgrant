-- ============================================================
-- 0004_dedup_key — per-event signature to stop re-ingested duplicates
-- ============================================================
-- The Apollo duplicates came from the agent re-scraping the source with no
-- memory of what it had already posted, so the same showing was ingested
-- repeatedly. This adds a signature column the ingest path computes from
-- source_id + normalized title + the session start/end window (see
-- lib/eventDedup.ts). Before inserting, the ingest path skips an incoming
-- event when a NON-rejected event with the same key already exists for the
-- source, and counts it in agent_runs.events_skipped_dup.
--
-- Deliberately NOT a UNIQUE constraint:
--   * rejected events can still be re-ingested later,
--   * correction re-submissions (fixedFromEventId) are never blocked,
--   * the segmentation rule is preserved — same title with a DIFFERENT
--     session window yields a different key, so it is kept.
-- Existing rows keep dedup_key = NULL (they never block new inserts); the key
-- is backfilled lazily as events are re-ingested.
-- ============================================================

ALTER TABLE raw_events
  ADD COLUMN dedup_key VARCHAR(64) NULL;

CREATE INDEX idx_raw_dedup ON raw_events(source_id, dedup_key);
