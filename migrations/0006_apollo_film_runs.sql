-- ============================================================
-- 0006_apollo_film_runs — observe each Apollo film's real end
-- ============================================================
-- Veezi shows a rolling ~2-week on-sale window, so a film's true end date isn't
-- knowable in advance — Apollo schedules week to week. This table records, per
-- film, when it was first seen on sale and the latest date seen. When a film
-- disappears from a later (weekly) feed run, ended_on is set to its last seen
-- date — that is its real end ("a movie goes on and on, then stops"). Populated
-- by GET /api/sources/apollo/feed; the feed degrades gracefully until applied.
-- ============================================================

CREATE TABLE IF NOT EXISTS apollo_film_runs (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  film_key      VARCHAR(255) NOT NULL,
  title         VARCHAR(255) NOT NULL,
  opened_on     DATE NOT NULL,
  last_seen_on  DATE NOT NULL,
  ended_on      DATE NULL,
  still_showing TINYINT(1) NOT NULL DEFAULT 1,
  first_run_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_apollo_film (film_key)
);
