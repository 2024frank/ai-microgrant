-- Poster discovery learned a fallback: pages that declare no share metadata
-- now yield their body content images. Events that already spent their
-- weekly discovery attempt under the metadata-only rule would otherwise wait
-- out the retry window before the new rule can help them, so their attempt
-- stamp is cleared once. Idempotent: rows that gained a poster since are
-- untouched, and re-running only re-arms rows that are still imageless.
UPDATE raw_events
SET image_discovery_at = NULL
WHERE status = 'pending'
  AND image_data IS NULL
  AND (image_cdn_url IS NULL OR image_cdn_url = '')
  AND image_discovery_at IS NOT NULL;
