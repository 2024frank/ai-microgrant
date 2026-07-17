-- The proximity pass still attached a neighboring announcement's flyer to
-- the Ball Game outing (its section on First Church's page has no image at
-- all). Discovery now rejects content images beyond a bounded distance from
-- the event's own title, so an image-free section correctly yields no
-- poster. Clear the misattributed flyer; the record stays held on its Event
-- image readiness check for a reviewer to supply one.
-- Idempotent: matches only rows still carrying that exact discovered URL.
UPDATE raw_events
SET image_data = NULL,
    image_cdn_url = NULL,
    image_discovery_at = NULL
WHERE status = 'pending'
  AND image_cdn_url = 'https://firstchurchoberlin.org/mt-content/uploads/2026/06/716670351_1616836283787306_5534970587311917373_n.jpg';
