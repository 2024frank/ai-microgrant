-- ============================================================
-- 0007_oberlin_payload_contract — match CommunityHub's API enums
-- ============================================================
-- CommunityHub has three post kinds: ot (event), an (announcement), and jp
-- (job). Older agents incorrectly stored category-like codes in event_type.
-- Categories remain in post_type_ids; this migration only repairs post kind.
--
-- Legacy display values are collapsed to ss (specific screens), the most
-- conservative valid target. Rows without screen_ids then fail the outbound
-- payload validator and require review rather than being broadened to "all".
-- Every statement is safe to re-run.
-- ============================================================

UPDATE raw_events
SET event_type = 'ot'
WHERE event_type IS NULL
   OR event_type NOT IN ('ot', 'an', 'jp');

UPDATE raw_events
SET display = 'ss'
WHERE display IN ('screen', 'none');

UPDATE raw_events
SET display = 'all'
WHERE display IS NULL
   OR display NOT IN ('all', 'ps', 'sps', 'ss');

ALTER TABLE raw_events
  MODIFY COLUMN event_type
    ENUM('ot','an','jp')
    NOT NULL DEFAULT 'ot';

ALTER TABLE raw_events
  MODIFY COLUMN display
    ENUM('all','ps','sps','ss')
    NOT NULL DEFAULT 'all';
