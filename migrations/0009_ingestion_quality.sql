-- ============================================================
-- 0009_ingestion_quality — reviewable validation + safe publish states
-- ============================================================
-- Keep deterministic contract issues beside each draft, preserve corrected
-- originals instead of deleting their evidence, and track outbound submission
-- attempts independently from the request that initiated them. Every additive
-- DDL statement is guarded because MySQL commits DDL implicitly; a deployment
-- can therefore retry this migration safely after a partial failure.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'validation_errors'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN validation_errors JSON NULL AFTER dedup_key'
);
PREPARE quality_ddl FROM @ddl;
EXECUTE quality_ddl;
DEALLOCATE PREPARE quality_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'superseded_by_id'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN superseded_by_id INT UNSIGNED NULL AFTER corrected_from_id'
);
PREPARE quality_ddl FROM @ddl;
EXECUTE quality_ddl;
DEALLOCATE PREPARE quality_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'publish_started_at'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN publish_started_at DATETIME NULL AFTER communityhub_post_id'
);
PREPARE quality_ddl FROM @ddl;
EXECUTE quality_ddl;
DEALLOCATE PREPARE quality_ddl;

-- Repeating this MODIFY is harmless and also reconciles a partially deployed
-- schema whose additive columns already exist.
ALTER TABLE raw_events
  MODIFY COLUMN status
    ENUM(
      'pending','approved','rejected','resubmitted','pending_fix',
      'publishing','superseded','submitted'
    ) NOT NULL DEFAULT 'pending';

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND index_name = 'idx_raw_validation'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD INDEX idx_raw_validation (status, source_id, created_at)'
);
PREPARE quality_ddl FROM @ddl;
EXECUTE quality_ddl;
DEALLOCATE PREPARE quality_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND index_name = 'idx_raw_superseded'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD INDEX idx_raw_superseded (superseded_by_id)'
);
PREPARE quality_ddl FROM @ddl;
EXECUTE quality_ddl;
DEALLOCATE PREPARE quality_ddl;

CREATE TABLE IF NOT EXISTS communityhub_submissions (
  id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  raw_event_id         INT UNSIGNED NOT NULL,
  payload_hash         CHAR(64) NOT NULL,
  status               ENUM('prepared','sending','accepted_unreconciled','succeeded','failed') NOT NULL DEFAULT 'prepared',
  payload              JSON NOT NULL,
  response             JSON NULL,
  error_message        TEXT NULL,
  communityhub_post_id VARCHAR(80) NULL,
  reviewer_id          INT UNSIGNED NULL,
  created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_submission_payload (raw_event_id, payload_hash),
  KEY idx_submission_status (status, updated_at),
  KEY idx_submission_event (raw_event_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
