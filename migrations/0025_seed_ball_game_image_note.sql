-- The First Church Ball Game outing (event 223) was verified by hand and by
-- the image-recovery agent before field_notes existed: the event section
-- publishes no image, the page exposes no og:image, and the Lake Erie
-- Crushers site carries only a generic group-outings page with no image for
-- this specific outing. Seed that verified explanation so the reviewer sees
-- why the image is empty. Guarded: applies only while the row is still the
-- imageless pending Ball Game draft and has no note yet, so it is a no-op on
-- reruns and once a reviewer attaches an image.
UPDATE raw_events
SET field_notes = JSON_OBJECT(
  'image_cdn_url',
  'The event page section publishes no image and the page exposes no share image; the Lake Erie Crushers site has only a generic group-outings page with no image for this specific outing.'
)
WHERE status = 'pending'
  AND field_notes IS NULL
  AND image_data IS NULL
  AND (image_cdn_url IS NULL OR image_cdn_url = '')
  AND calendar_source_url = 'https://firstchurchoberlin.org/events/'
  AND title LIKE '%Ball Game%';
