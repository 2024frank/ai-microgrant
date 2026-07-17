-- The first content-image discovery pass attached the page's first photo in
-- document order, which on First Church's multi-event announcements page is
-- the Summer Storytime picture, not the Ball Game outing's. Discovery now
-- orders content images by proximity to the event's own title; clear the
-- misattributed poster and its attempt stamp so the corrected rule re-runs.
-- Idempotent: matches only rows still carrying that exact discovered URL.
UPDATE raw_events
SET image_data = NULL,
    image_cdn_url = NULL,
    image_discovery_at = NULL
WHERE status = 'pending'
  AND image_cdn_url = 'https://firstchurchoberlin.org/mt-content/uploads/2025/05/unnamed-2025-05-01t122827.160.jpg';
