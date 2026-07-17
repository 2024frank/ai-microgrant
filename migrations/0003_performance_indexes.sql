-- ============================================================
-- 0003_performance_indexes — guarded composite indexes
-- ============================================================
-- Every index is conditionally created so a process crash after MySQL's
-- implicit DDL commit can be retried before schema_migrations is recorded.
-- ============================================================

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND index_name='idx_raw_status_created'
), 'SELECT 1', 'CREATE INDEX idx_raw_status_created ON raw_events(status, created_at)');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND index_name='idx_raw_source_status_created'
), 'SELECT 1', 'CREATE INDEX idx_raw_source_status_created ON raw_events(source_id, status, created_at)');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND index_name='idx_raw_corrected_status'
), 'SELECT 1', 'CREATE INDEX idx_raw_corrected_status ON raw_events(corrected_from_id, status)');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND index_name='idx_raw_calsrcurl'
), 'SELECT 1', 'CREATE INDEX idx_raw_calsrcurl ON raw_events(calendar_source_url(191))');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='review_sessions' AND index_name='idx_rsess_reviewer_action'
), 'SELECT 1', 'CREATE INDEX idx_rsess_reviewer_action ON review_sessions(reviewer_id, action, created_at)');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='agent_runs' AND index_name='idx_run_source_started'
), 'SELECT 1', 'CREATE INDEX idx_run_source_started ON agent_runs(source_id, started_at)');
PREPARE index_ddl FROM @ddl; EXECUTE index_ddl; DEALLOCATE PREPARE index_ddl;
