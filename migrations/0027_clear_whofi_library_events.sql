-- The library source was repointed from WhoFi to Locable, but the pre-existing
-- WhoFi library drafts (each carrying the library logo as its "image", not the
-- event's real photo) still sit in the queue. New Locable events share the same
-- titles and dates, so they were suppressed as duplicates of the WhoFi rows
-- instead of replacing them. Remove the unreviewed WhoFi library drafts so the
-- Locable events - which carry each event's real image - can enter review.
-- Scoped to the library source, to WhoFi-sourced rows, and to unreviewed
-- states only (published/submitted history is untouched). Idempotent: once the
-- WhoFi drafts are gone and Locable is the source, this matches nothing.
DELETE FROM raw_events
WHERE source_id = 7
  AND status IN ('pending', 'duplicate')
  AND (
    calendar_source_url LIKE '%whofi.com%'
    OR image_cdn_url LIKE '%squarespace-cdn.com%BracketBold%'
  );
