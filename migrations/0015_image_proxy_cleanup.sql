-- ============================================================
-- 0015_image_proxy_cleanup — remove recursive local poster URLs
-- ============================================================
-- Older ingest code stored both the embedded image bytes and this application's
-- own poster route in image_cdn_url. Once cleanup removed the bytes, the poster
-- handler fetched itself recursively. The outbound CommunityHub payload derives
-- a signed proxy URL when image_data exists, so this stored self-reference is
-- redundant and safe to remove before application promotion.
-- ============================================================

UPDATE raw_events
SET image_cdn_url = NULL
WHERE image_cdn_url LIKE CONCAT('%/api/events/', id, '/poster.jpg%')
   OR image_cdn_url LIKE CONCAT('%/api/events/', id, '/image%');
