-- ============================================================
-- 0014_scheduler_retry_slots — retry failed scheduled dispatches
-- ============================================================
-- A failed scheduled run must release its source+slot reservation so the
-- trigger can make a bounded retry. Running, completed, and stopped runs keep
-- the reservation, preserving idempotency for active or terminal non-failure
-- outcomes. Manual runs have a NULL schedule_slot and remain unaffected.
--
-- Each DDL statement is guarded because MySQL implicitly commits DDL. The old
-- unique key is intentionally dropped last, after its replacement is active,
-- so a partially applied migration never leaves scheduled claims unprotected.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND column_name = 'reserved_schedule_slot'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN reserved_schedule_slot DATETIME GENERATED ALWAYS AS (CASE WHEN status IN (''running'',''completed'',''stopped'') THEN schedule_slot ELSE NULL END) VIRTUAL'
);
PREPARE scheduler_retry_ddl FROM @ddl;
EXECUTE scheduler_retry_ddl;
DEALLOCATE PREPARE scheduler_retry_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND index_name = 'uq_agent_runs_reserved_schedule_slot'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD UNIQUE KEY uq_agent_runs_reserved_schedule_slot (source_id, reserved_schedule_slot)'
);
PREPARE scheduler_retry_ddl FROM @ddl;
EXECUTE scheduler_retry_ddl;
DEALLOCATE PREPARE scheduler_retry_ddl;

-- Drop the unconditional source+slot key only after the status-aware key is
-- present. Re-running after any intermediate DDL commit is therefore safe.
SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND index_name = 'uq_agent_runs_schedule_slot'
  ),
  'ALTER TABLE agent_runs DROP INDEX uq_agent_runs_schedule_slot',
  'SELECT 1'
);
PREPARE scheduler_retry_ddl FROM @ddl;
EXECUTE scheduler_retry_ddl;
DEALLOCATE PREPARE scheduler_retry_ddl;
