-- ============================================================
-- 0017_communityhub_content_reconciliation
-- Recoverable audit records for content-based stale submission deletion.
-- ============================================================
-- CommunityHub and Event Intake IDs are unrelated. Reconciliation therefore
-- compares complete event content and archives the local row plus its related
-- audit records before removing a proven-absent submitted row from dedup.
-- This table intentionally has no foreign keys so its evidence survives the
-- raw_events deletion it documents.
-- ============================================================

CREATE TABLE IF NOT EXISTS communityhub_reconciliation_deletions (
  id                         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  raw_event_id               BIGINT NOT NULL,
  source_id                  BIGINT NOT NULL,
  event_title                VARCHAR(255) NOT NULL,
  dedup_key                  VARCHAR(64) NULL,
  reason                     VARCHAR(120) NOT NULL,
  event_snapshot             JSON NOT NULL,
  remote_inventory_sha256    CHAR(64) NOT NULL,
  remote_approved_count      INT UNSIGNED NOT NULL,
  remote_pending_count       INT UNSIGNED NOT NULL,
  deleted_at                 DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_ch_reconcile_event (raw_event_id, deleted_at),
  KEY idx_ch_reconcile_source (source_id, deleted_at),
  KEY idx_ch_reconcile_inventory (remote_inventory_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
