-- ============================================================
-- 0002_reconcile — force ENUM columns onto the known-good union
-- ============================================================
-- 0001 only creates tables that don't already exist, so on an EXISTING
-- (production) database it leaves the original, narrower ENUM definitions in
-- place. The application inserts values outside those old ENUMs (e.g.
-- event_type 'ev'/'cl', status 'pending_fix', review action
-- 'sent_for_correction'), which MySQL would otherwise reject or silently
-- coerce to ''. These MODIFY statements are idempotent — re-applying the same
-- definition is a no-op — so they safely converge both fresh and drifted DBs.
-- The unions are supersets of every value the schema or code has ever used,
-- so no existing row can fall outside them.
-- ============================================================

ALTER TABLE raw_events
  MODIFY COLUMN event_type
    ENUM('ot','an','jp','ev','cl','ex','vt','sp','pe','wk','ms','ws')
    NOT NULL DEFAULT 'ot';

ALTER TABLE raw_events
  MODIFY COLUMN display
    ENUM('all','ps','sps','ss','screen','none')
    NOT NULL DEFAULT 'all';

ALTER TABLE raw_events
  MODIFY COLUMN geo_scope
    ENUM('local','hyper_local','city_wide','county','regional','national')
    NULL;

ALTER TABLE raw_events
  MODIFY COLUMN status
    ENUM('pending','submitted','approved','rejected','resubmitted','pending_fix')
    NOT NULL DEFAULT 'pending';

ALTER TABLE review_sessions
  MODIFY COLUMN action
    ENUM('approved','rejected','sent_for_correction')
    NOT NULL;
