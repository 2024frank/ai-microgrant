-- ============================================================
-- 0019_nullable_system_reviewers
-- ============================================================
-- The baseline declares reviewer columns as NULLable (a NULL reviewer is a
-- system action: automatic conformance corrections, system rejections,
-- automatic correction dispatches), but the production database drifted to
-- NOT NULL on field_edit_log.reviewer_id, which made the queue-conformance
-- sweep's audit inserts fail. Reconcile every audit table that records
-- system actions. MODIFY is repeatable, so this migration can be retried.
-- ============================================================

ALTER TABLE field_edit_log
  MODIFY COLUMN reviewer_id INT UNSIGNED NULL;

ALTER TABLE rejection_log
  MODIFY COLUMN reviewer_id INT UNSIGNED NULL;

ALTER TABLE review_sessions
  MODIFY COLUMN reviewer_id INT UNSIGNED NULL;

ALTER TABLE needs_fix
  MODIFY COLUMN sent_by_user_id INT NULL;
