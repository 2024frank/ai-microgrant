-- ============================================================
-- 0018_run_comparisons_and_source_metadata
-- ============================================================
-- July 16 meeting follow-ups:
--   * Preserve imported candidates that are rejected as duplicates so their
--     quality can be evaluated (raw_events.status gains 'duplicate', plus
--     duplicate_of_id / communityhub_match evidence columns).
--   * Record a two-way comparison per integration run (integration vs the
--     CommunityHub calendar) in integration_run_comparisons.
--   * Store stable organization metadata on sources instead of asking the
--     agent to rediscover it, and classify sources as original-organization
--     integrations vs aggregators for deterministic source priority.
--   * Allow system-originated rejections (automatic required-field rejection).
-- Every additive statement is guarded because MySQL commits DDL implicitly;
-- this migration can be retried safely after a partial failure.
-- ============================================================

-- Repeating a MODIFY is harmless and reconciles partially deployed schemas.
ALTER TABLE raw_events
  MODIFY COLUMN status
    ENUM(
      'pending','approved','rejected','resubmitted','pending_fix',
      'publishing','superseded','submitted','duplicate'
    ) NOT NULL DEFAULT 'pending';

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'duplicate_of_id'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN duplicate_of_id INT UNSIGNED NULL AFTER superseded_by_id'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'communityhub_match'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN communityhub_match JSON NULL AFTER duplicate_of_id'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

ALTER TABLE rejection_log
  MODIFY COLUMN rejection_origin
    ENUM('reviewer','communityhub','system') NOT NULL DEFAULT 'reviewer';

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'source_kind'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN source_kind ENUM(''original_org'',''aggregator'') NOT NULL DEFAULT ''original_org'' AFTER source_type'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'org_sponsor_name'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN org_sponsor_name VARCHAR(120) NULL AFTER calendar_source_name'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'org_website'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN org_website VARCHAR(500) NULL AFTER org_sponsor_name'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'org_phone'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN org_phone VARCHAR(30) NULL AFTER org_website'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'sources' AND column_name = 'org_contact_email'
  ),
  'SELECT 1',
  'ALTER TABLE sources ADD COLUMN org_contact_email VARCHAR(150) NULL AFTER org_phone'
);
PREPARE comparison_ddl FROM @ddl;
EXECUTE comparison_ddl;
DEALLOCATE PREPARE comparison_ddl;

-- org_sponsor_name is left NULL on purpose: only explicitly configured
-- values are stamped onto events (a shared inbox or an aggregator is not the
-- organizer of what it relays). scripts/set-source-org-metadata.ts fills in
-- the verified organizations. Aggregators are recognizable by name today.
UPDATE sources SET source_kind = 'aggregator'
WHERE (slug LIKE '%localist%' OR name LIKE '%localist%' OR slug LIKE '%aggregat%')
  AND source_kind = 'original_org';

CREATE TABLE IF NOT EXISTS integration_run_comparisons (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  agent_run_id      INT UNSIGNED NOT NULL,
  source_id         INT UNSIGNED NOT NULL,
  status            ENUM('complete','inventory_unavailable') NOT NULL DEFAULT 'complete',
  inventory_sha256  CHAR(64) NULL,
  remote_approved   INT UNSIGNED NOT NULL DEFAULT 0,
  remote_pending    INT UNSIGNED NOT NULL DEFAULT 0,
  matched_both      INT UNSIGNED NOT NULL DEFAULT 0,
  integration_only  INT UNSIGNED NOT NULL DEFAULT 0,
  calendar_only     INT UNSIGNED NOT NULL DEFAULT 0,
  duplicates_preserved INT UNSIGNED NOT NULL DEFAULT 0,
  report            JSON NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_comparison_run (agent_run_id),
  KEY idx_comparison_source (source_id, created_at),
  CONSTRAINT fk_cmp_run    FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT fk_cmp_source FOREIGN KEY (source_id)    REFERENCES sources(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
