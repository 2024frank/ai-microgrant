-- ============================================================
-- 0011_identity_scope_integrity — safe invitation identity claims
-- ============================================================
-- Empty strings cannot represent unclaimed identities in a UNIQUE column:
-- MySQL permits many NULL values but only one ''. Make invitations nullable,
-- then turn the historical implicit "no assignments means all" behavior into
-- an explicit permission that new invitation code must opt into.
-- ============================================================

ALTER TABLE users
  MODIFY COLUMN firebase_uid VARCHAR(128) NULL DEFAULT NULL;

UPDATE users SET firebase_uid = NULL WHERE firebase_uid = '';

SET @scope_column_was_missing = NOT EXISTS(
  SELECT 1 FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'users'
    AND column_name = 'can_review_all_sources'
);

SET @ddl = IF(
  @scope_column_was_missing,
  'ALTER TABLE users ADD COLUMN can_review_all_sources TINYINT(1) NOT NULL DEFAULT 0 AFTER role',
  'SELECT 1'
);
PREPARE identity_ddl FROM @ddl;
EXECUTE identity_ddl;
DEALLOCATE PREPARE identity_ddl;

-- Deliberately do not infer global access from missing assignment rows. Some
-- legacy rows were left assignmentless by partial writes, so a backfill would
-- silently convert failed setup into all-source access. Administrators must
-- explicitly opt reviewers into global access in the updated controls.
