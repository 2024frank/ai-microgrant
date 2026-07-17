-- ============================================================
-- 0024_field_notes
-- ============================================================
-- When the source genuinely publishes no value for a field the platform
-- expects (most often the event image, but also an end time or website),
-- the extraction and correction agents now record a short factual note
-- explaining why. Reviewers see the note on the failing readiness check
-- instead of an unexplained empty field. One JSON object per row mapping a
-- field name to its explanation.
-- ============================================================

SET @ddl = IF(
  EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = DATABASE() AND table_name = 'raw_events' AND column_name = 'field_notes'
  ),
  'SELECT 1',
  'ALTER TABLE raw_events ADD COLUMN field_notes JSON NULL AFTER validation_errors'
);
PREPARE field_notes_ddl FROM @ddl;
EXECUTE field_notes_ddl;
DEALLOCATE PREPARE field_notes_ddl;
