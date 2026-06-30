-- ============================================================
-- 0003_performance_indexes — composite indexes for hot query paths
-- ============================================================
-- Additive, runs once (tracked in schema_migrations). These back the
-- multi-column WHERE/ORDER patterns the app uses and were documented in the
-- README but never actually present in the database. MySQL 8 has no
-- "CREATE INDEX IF NOT EXISTS", so if a name here already exists the runner
-- will abort loudly rather than silently double-create — adjust and re-run.
-- The single-column indexes from 0001 are intentionally left in place.
-- notifications(user_id, read_at) already exists as idx_user_unread (0001).
-- ============================================================

-- Review queue: filter by status, sort by ingestion date.
CREATE INDEX idx_raw_status_created        ON raw_events(status, created_at);

-- Source-scoped queue and per-source stats.
CREATE INDEX idx_raw_source_status_created ON raw_events(source_id, status, created_at);

-- Reviewer dashboard "how many of my corrections were approved" join.
CREATE INDEX idx_raw_corrected_status      ON raw_events(corrected_from_id, status);

-- Fix-agent fallback lookup by source URL (TEXT column → prefix index).
CREATE INDEX idx_raw_calsrcurl             ON raw_events(calendar_source_url(191));

-- Personal reviewer stats (per reviewer, per action, over time).
CREATE INDEX idx_rsess_reviewer_action     ON review_sessions(reviewer_id, action, created_at);

-- Last-run-status lookup per source.
CREATE INDEX idx_run_source_started        ON agent_runs(source_id, started_at);
