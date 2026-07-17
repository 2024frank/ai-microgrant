-- ============================================================
-- 0020_image_discovery_tracking
-- ============================================================
-- The queue-conformance sweep discovers missing posters from each event's
-- source page. Attempts must be remembered, or the bounded per-sweep budget
-- retries the same posterless events forever and never reaches the rest.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'image_discovery_at'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN image_discovery_at DATETIME NULL AFTER image_data'
);
PREPARE discovery_ddl FROM @ddl;
EXECUTE discovery_ddl;
DEALLOCATE PREPARE discovery_ddl;
