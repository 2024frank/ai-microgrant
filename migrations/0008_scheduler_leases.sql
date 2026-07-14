-- ============================================================
-- 0008_scheduler_leases — durable, idempotent per-source dispatch
-- ============================================================
-- source_type already exists in some production databases but was missing from
-- the canonical migrations. Each DDL statement is guarded through
-- INFORMATION_SCHEMA so this migration can be retried after MySQL's implicit
-- DDL commits. schedule_slot is a UTC DATETIME selected by the dispatcher.
--
-- Two unique keys provide the atomic guarantees the route cannot provide with
-- SELECT-then-INSERT:
--   * one currently-running row per source (generated nullable lease key),
--   * one claim per source/scheduled slot, even after that run finishes.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'source_type'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN source_type ENUM(''web'',''email'') NOT NULL DEFAULT ''web'' AFTER agent_id'
);
PREPARE scheduler_ddl FROM @ddl;
EXECUTE scheduler_ddl;
DEALLOCATE PREPARE scheduler_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'agent_runs' AND column_name = 'schedule_slot'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN schedule_slot DATETIME NULL AFTER started_at'
);
PREPARE scheduler_ddl FROM @ddl;
EXECUTE scheduler_ddl;
DEALLOCATE PREPARE scheduler_ddl;

-- Reconcile historical duplicate running rows before adding the unique lease.
-- Keep the newest row for each source and close every older duplicate.
UPDATE agent_runs ar
JOIN (
  SELECT source_id, MAX(id) AS keep_id
  FROM agent_runs
  WHERE status = 'running'
  GROUP BY source_id
  HAVING COUNT(*) > 1
) duplicates ON duplicates.source_id = ar.source_id
SET ar.status = 'failed',
    ar.finished_at = NOW(),
    ar.error_log = JSON_ARRAY('Closed duplicate running row during scheduler lease migration')
WHERE ar.status = 'running' AND ar.id <> duplicates.keep_id;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'agent_runs' AND column_name = 'running_source_id'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN running_source_id INT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status = ''running'' THEN source_id ELSE NULL END) STORED'
);
PREPARE scheduler_ddl FROM @ddl;
EXECUTE scheduler_ddl;
DEALLOCATE PREPARE scheduler_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'agent_runs' AND index_name = 'uq_agent_runs_running_source'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD UNIQUE KEY uq_agent_runs_running_source (running_source_id)'
);
PREPARE scheduler_ddl FROM @ddl;
EXECUTE scheduler_ddl;
DEALLOCATE PREPARE scheduler_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'agent_runs' AND index_name = 'uq_agent_runs_schedule_slot'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD UNIQUE KEY uq_agent_runs_schedule_slot (source_id, schedule_slot)'
);
PREPARE scheduler_ddl FROM @ddl;
EXECUTE scheduler_ddl;
DEALLOCATE PREPARE scheduler_ddl;
