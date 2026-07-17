-- ============================================================
-- 0012_communityhub_moderation — transport success is not approval
-- ============================================================
-- CommunityHub's documented `post.approved` state is tri-state:
-- NULL=pending, 0=rejected, 1=approved. A successful submission therefore
-- enters `submitted` until the reconciliation worker observes moderation.
-- ============================================================

ALTER TABLE raw_events
  MODIFY COLUMN status
    ENUM(
      'pending','submitted','approved','rejected','resubmitted','pending_fix',
      'publishing','superseded'
    ) NOT NULL DEFAULT 'pending';

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events'
      AND column_name = 'communityhub_moderation_status'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN communityhub_moderation_status ENUM(''unknown'',''pending'',''approved'',''rejected'',''missing'') NOT NULL DEFAULT ''unknown'' AFTER communityhub_post_id'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events'
      AND column_name = 'communityhub_checked_at'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN communityhub_checked_at DATETIME NULL AFTER communityhub_moderation_status'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events'
      AND column_name = 'communityhub_moderation_error'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN communityhub_moderation_error TEXT NULL AFTER communityhub_checked_at'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'raw_events'
      AND index_name = 'idx_raw_ch_moderation'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD INDEX idx_raw_ch_moderation (communityhub_moderation_status, status, communityhub_checked_at)'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

ALTER TABLE communityhub_submissions
  MODIFY COLUMN status
    ENUM('prepared','sending','accepted_unreconciled','succeeded','failed')
    NOT NULL DEFAULT 'prepared';

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'rejection_log'
      AND column_name = 'rejection_origin'
  ),
  'SELECT 1',
  'ALTER TABLE rejection_log ADD COLUMN rejection_origin ENUM(''reviewer'',''communityhub'') NOT NULL DEFAULT ''reviewer'' AFTER event_snapshot'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'rejection_log'
      AND column_name = 'external_rejection_key'
  ),
  'SELECT 1',
  'ALTER TABLE rejection_log ADD COLUMN external_rejection_key VARCHAR(190) NULL AFTER rejection_origin'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.statistics
    WHERE table_schema = DATABASE() AND table_name = 'rejection_log'
      AND index_name = 'uq_rej_external'
  ),
  'SELECT 1',
  'ALTER TABLE rejection_log ADD UNIQUE KEY uq_rej_external (raw_event_id, external_rejection_key)'
);
PREPARE moderation_ddl FROM @ddl;
EXECUTE moderation_ddl;
DEALLOCATE PREPARE moderation_ddl;

-- Do not mutate existing publication state inside this pre-promotion schema
-- migration. The new application requires moderation_status='approved' for
-- public access and atomically demotes legacy unknown rows when its first
-- reconciliation run starts. This expand/deploy/backfill order ensures a later
-- migration or deployment failure cannot leave the old application with an
-- empty public feed.
