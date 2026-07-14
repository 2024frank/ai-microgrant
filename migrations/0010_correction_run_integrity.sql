-- ============================================================
-- 0010_correction_run_integrity — bind correction runs to one event
-- ============================================================
-- The binding is consumed by both managed-agent JSON ingestion and direct
-- HTTP ingestion. It lets the shared persistence layer reject unrelated or
-- multi-event output before any draft is written.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND column_name = 'correction_event_id'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN correction_event_id INT UNSIGNED NULL AFTER schedule_slot'
);
PREPARE correction_ddl FROM @ddl;
EXECUTE correction_ddl;
DEALLOCATE PREPARE correction_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND index_name = 'idx_agent_runs_correction'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD INDEX idx_agent_runs_correction (correction_event_id, status)'
);
PREPARE correction_ddl FROM @ddl;
EXECUTE correction_ddl;
DEALLOCATE PREPARE correction_ddl;
