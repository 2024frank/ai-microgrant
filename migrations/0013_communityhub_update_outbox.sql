-- ============================================================
-- 0013_communityhub_update_outbox — lossless published edits
-- ============================================================
-- A CommunityHub PATCH is idempotent but its network outcome can be
-- ambiguous. Persist both the canonical remote patch and the exact local
-- changes before making the request so reconciliation can safely replay and
-- finish either side after a timeout or process crash.
-- ============================================================

CREATE TABLE IF NOT EXISTS communityhub_updates (
  id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  operation_key         CHAR(36) NOT NULL,
  raw_event_id          INT UNSIGNED NOT NULL,
  communityhub_post_id  VARCHAR(80) NOT NULL,
  original_status       VARCHAR(32) NOT NULL,
  status                ENUM('sending','ambiguous','succeeded','failed') NOT NULL DEFAULT 'sending',
  ch_edits              JSON NOT NULL,
  local_edits           JSON NOT NULL,
  audit_entries         JSON NOT NULL,
  reviewer_id           INT UNSIGNED NULL,
  response              JSON NULL,
  error_message         TEXT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ch_update_operation (operation_key),
  KEY idx_ch_update_pending (status, updated_at),
  KEY idx_ch_update_event (raw_event_id, created_at),
  CONSTRAINT fk_ch_update_event
    FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
