-- ============================================================
-- 0016_agent_continuation_leases — durable managed-agent handoff
-- ============================================================
-- Managed-agent sessions can outlive one serverless invocation. These fields
-- provide a short, renewable database lease so duplicate admin, workflow, and
-- self-continuation requests cannot create competing monitor loops. A crashed
-- worker releases itself automatically when continuation_lease_until expires.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND column_name = 'continuation_token'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN continuation_token VARCHAR(64) NULL'
);
PREPARE continuation_lease_ddl FROM @ddl;
EXECUTE continuation_lease_ddl;
DEALLOCATE PREPARE continuation_lease_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = 'agent_runs'
      AND column_name = 'continuation_lease_until'
  ),
  'SELECT 1',
  'ALTER TABLE agent_runs ADD COLUMN continuation_lease_until DATETIME(3) NULL'
);
PREPARE continuation_lease_ddl FROM @ddl;
EXECUTE continuation_lease_ddl;
DEALLOCATE PREPARE continuation_lease_ddl;
