-- ============================================================
-- 0004_dedup_key — retry-safe event signatures
-- ============================================================

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND column_name='dedup_key'
), 'SELECT 1', 'ALTER TABLE raw_events ADD COLUMN dedup_key VARCHAR(64) NULL');
PREPARE dedup_ddl FROM @ddl; EXECUTE dedup_ddl; DEALLOCATE PREPARE dedup_ddl;

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.statistics
  WHERE table_schema=DATABASE() AND table_name='raw_events' AND index_name='idx_raw_dedup'
), 'SELECT 1', 'CREATE INDEX idx_raw_dedup ON raw_events(source_id, dedup_key)');
PREPARE dedup_ddl FROM @ddl; EXECUTE dedup_ddl; DEALLOCATE PREPARE dedup_ddl;
