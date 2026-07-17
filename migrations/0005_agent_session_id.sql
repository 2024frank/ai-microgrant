-- ============================================================
-- 0005_agent_session_id — retry-safe managed-agent session id
-- ============================================================

SET @ddl = IF(EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema=DATABASE() AND table_name='agent_runs' AND column_name='session_id'
), 'SELECT 1', 'ALTER TABLE agent_runs ADD COLUMN session_id VARCHAR(120) NULL');
PREPARE session_ddl FROM @ddl; EXECUTE session_ddl; DEALLOCATE PREPARE session_ddl;
