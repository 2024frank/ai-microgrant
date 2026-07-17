-- ============================================================
-- 0001_baseline — full known-good schema
-- ============================================================
-- Idempotent: every table uses CREATE TABLE IF NOT EXISTS, so this file is
-- a no-op against an existing (production) database and a full build against
-- a fresh one. It does NOT drop anything. Run via `npm run db:migrate`.
--
-- This baseline reconciles the schema that the application code actually
-- expects (reconstructed from src/ + the legacy scripts/migrate-*.ts files)
-- which had drifted from the old schema.sql. Differences vs. the old schema:
--   * adds tables: needs_fix, notifications, event_stats_archive
--   * adds raw_events columns: email, corrected_from_id, sent_for_fix_by,
--     sent_for_correction
--   * widens ENUMs to the union of every value the code reads/writes
--     (see 0002_reconcile.sql, which forces these onto already-existing DBs)
-- ============================================================

-- 1. SOURCES — one event calendar per row; one Claude agent per source.
CREATE TABLE IF NOT EXISTS sources (
  id                   INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name                 VARCHAR(120) NOT NULL,
  slug                 VARCHAR(80)  NOT NULL UNIQUE,
  agent_id             VARCHAR(120) NOT NULL UNIQUE,
  schedule_cron        VARCHAR(50)  NOT NULL DEFAULT '0 6 * * *',
  calendar_source_name VARCHAR(120) NOT NULL,
  active               TINYINT(1)   NOT NULL DEFAULT 1,
  created_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. USERS — pre-registered accounts; cannot sign in until added by an admin.
CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  firebase_uid  VARCHAR(128) NULL DEFAULT NULL UNIQUE,
  email         VARCHAR(150) NOT NULL UNIQUE,
  full_name     VARCHAR(120) NOT NULL,
  role          ENUM('admin','reviewer') NOT NULL DEFAULT 'reviewer',
  can_review_all_sources TINYINT(1) NOT NULL DEFAULT 0,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. REVIEWER ↔ SOURCE ASSIGNMENTS
CREATE TABLE IF NOT EXISTS reviewer_sources (
  reviewer_id INT UNSIGNED NOT NULL,
  source_id   INT UNSIGNED NOT NULL,
  assigned_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (reviewer_id, source_id),
  CONSTRAINT fk_rs_reviewer FOREIGN KEY (reviewer_id) REFERENCES users(id)   ON DELETE CASCADE,
  CONSTRAINT fk_rs_source   FOREIGN KEY (source_id)   REFERENCES sources(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. AGENT RUNS — full execution log per agent invocation.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                  INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source_id           INT UNSIGNED    NOT NULL,
  started_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at         DATETIME        NULL,
  status              ENUM('running','completed','failed','stopped') NOT NULL DEFAULT 'running',
  events_found        INT UNSIGNED    NOT NULL DEFAULT 0,
  events_extracted    INT UNSIGNED    NOT NULL DEFAULT 0,
  events_skipped_dup  INT UNSIGNED    NOT NULL DEFAULT 0,
  events_errored      INT UNSIGNED    NOT NULL DEFAULT 0,
  communityhub_dup    INT UNSIGNED    NOT NULL DEFAULT 0,
  system_dup          INT UNSIGNED    NOT NULL DEFAULT 0,
  prompt_tokens       INT UNSIGNED    NULL,
  completion_tokens   INT UNSIGNED    NULL,
  error_log           JSON            NULL,
  KEY idx_run_source  (source_id),
  KEY idx_run_started (started_at),
  KEY idx_run_status  (status),
  CONSTRAINT fk_run_source FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 5. RAW EVENTS — every event any agent extracts; moves through the review lifecycle.
CREATE TABLE IF NOT EXISTS raw_events (
  id                    INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source_id             INT UNSIGNED    NOT NULL,
  agent_run_id          INT UNSIGNED    NOT NULL,
  event_type            ENUM('ot','an','jp','ev','cl','ex','vt','sp','pe','wk','ms','ws') NOT NULL DEFAULT 'ot',
  title                 VARCHAR(60)                       NOT NULL,
  description           VARCHAR(200)                      NOT NULL,
  extended_description  VARCHAR(1000)                     NULL,
  sponsors              JSON                              NOT NULL,
  post_type_ids         JSON                              NOT NULL,
  sessions              JSON                              NOT NULL,
  location_type         ENUM('ph2','on','bo','ne')        NOT NULL DEFAULT 'ne',
  location              VARCHAR(255)                      NULL,
  place_id              VARCHAR(120)                      NULL,
  place_name            VARCHAR(120)                      NULL,
  room_num              VARCHAR(80)                       NULL,
  url_link              TEXT                              NULL,
  display               ENUM('all','ps','sps','ss','screen','none') NOT NULL DEFAULT 'all',
  screen_ids            JSON                              NULL,
  buttons               JSON                              NULL,
  contact_email         VARCHAR(150)                      NULL,
  email                 VARCHAR(150)                      NULL,
  phone                 VARCHAR(30)                       NULL,
  website               TEXT                              NULL,
  image_cdn_url         TEXT                              NULL,
  image_data            MEDIUMTEXT                        NULL,
  calendar_source_name  VARCHAR(120)                      NULL,
  calendar_source_url   TEXT                              NULL,
  ingested_post_url     TEXT                              NULL,
  geo_scope             ENUM('local','hyper_local','city_wide','county','regional','national') NULL,
  geo_json              JSON                              NULL,
  status                ENUM('pending','submitted','approved','rejected','resubmitted','pending_fix') NOT NULL DEFAULT 'pending',
  communityhub_post_id  VARCHAR(80)                       NULL,
  communityhub_moderation_status ENUM('unknown','pending','approved','rejected','missing') NOT NULL DEFAULT 'unknown',
  communityhub_checked_at DATETIME                        NULL,
  communityhub_moderation_error TEXT                      NULL,
  corrected_from_id     INT                               NULL,
  sent_for_fix_by       VARCHAR(255)                      NULL,
  sent_for_correction   TINYINT(1)      NOT NULL DEFAULT 0,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_raw_status  (status),
  KEY idx_raw_source  (source_id),
  KEY idx_raw_created (created_at),
  CONSTRAINT fk_raw_source FOREIGN KEY (source_id)    REFERENCES sources(id)    ON DELETE CASCADE,
  CONSTRAINT fk_raw_run    FOREIGN KEY (agent_run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 6. REJECTION LOG — feeds the agent learning loop (rejection history → next prompt).
CREATE TABLE IF NOT EXISTS rejection_log (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  raw_event_id   INT UNSIGNED    NOT NULL,
  source_id      INT UNSIGNED    NOT NULL,
  reviewer_id    INT UNSIGNED    NULL,
  reason_codes   JSON            NOT NULL,
  reviewer_note  TEXT            NULL,
  event_title    VARCHAR(60)     NOT NULL,
  event_snapshot JSON            NOT NULL,
  rejection_origin ENUM('reviewer','communityhub') NOT NULL DEFAULT 'reviewer',
  external_rejection_key VARCHAR(190) NULL,
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rej_source  (source_id),
  KEY idx_rej_created (created_at),
  UNIQUE KEY uq_rej_external (raw_event_id, external_rejection_key),
  CONSTRAINT fk_rej_raw    FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_rej_source FOREIGN KEY (source_id)    REFERENCES sources(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. FIELD EDIT LOG — every reviewer field correction.
CREATE TABLE IF NOT EXISTS field_edit_log (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  raw_event_id INT UNSIGNED    NOT NULL,
  source_id    INT UNSIGNED    NOT NULL,
  reviewer_id  INT UNSIGNED    NULL,
  field_name   VARCHAR(60)     NOT NULL,
  old_value    TEXT            NULL,
  new_value    TEXT            NULL,
  created_at   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_edit_source (source_id),
  KEY idx_edit_field  (field_name),
  CONSTRAINT fk_edit_raw    FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE,
  CONSTRAINT fk_edit_source FOREIGN KEY (source_id)    REFERENCES sources(id)    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. REVIEW SESSIONS — every reviewer action with timing.
CREATE TABLE IF NOT EXISTS review_sessions (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  raw_event_id    INT UNSIGNED    NOT NULL,
  reviewer_id     INT UNSIGNED    NULL,
  action          ENUM('approved','rejected','sent_for_correction') NOT NULL,
  time_spent_sec  INT UNSIGNED    NULL,
  submitted_to_ch TINYINT(1)      NOT NULL DEFAULT 0,
  ch_response     JSON            NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rsess_action  (action),
  KEY idx_rsess_created (created_at),
  CONSTRAINT fk_rsess_raw FOREIGN KEY (raw_event_id) REFERENCES raw_events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. NEEDS FIX — events currently awaiting AI correction (one row per event).
--    Intentionally FK-free (matches production, created by scripts/migrate-needs-fix.ts);
--    the application cleans these up explicitly.
CREATE TABLE IF NOT EXISTS needs_fix (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  raw_event_id     INT          NOT NULL,
  source_id        INT          NOT NULL,
  correction_notes TEXT         NOT NULL,
  sent_by_user_id  INT          NULL,
  sent_by_email    VARCHAR(255) NULL,
  created_at       TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_event (raw_event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. NOTIFICATIONS — in-app bell notifications (FK-free, matches production).
CREATE TABLE IF NOT EXISTS notifications (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT          NOT NULL,
  type         VARCHAR(50)  NOT NULL DEFAULT 'event_fixed',
  title        VARCHAR(255) NULL,
  message      TEXT         NULL,
  raw_event_id INT          NULL,
  read_at      TIMESTAMP    NULL,
  created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_user_unread (user_id, read_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. EVENT STATS ARCHIVE — per-source counts snapshotted before cleanup deletion,
--     so historical stats survive event expiry. FK-free so archives outlive sources.
CREATE TABLE IF NOT EXISTS event_stats_archive (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source_id      INT UNSIGNED NULL,
  source_name    VARCHAR(120) NULL,
  total          INT UNSIGNED NOT NULL DEFAULT 0,
  approved       INT UNSIGNED NOT NULL DEFAULT 0,
  rejected       INT UNSIGNED NOT NULL DEFAULT 0,
  edited         INT UNSIGNED NOT NULL DEFAULT 0,
  snapshotted_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_arch_source     (source_id),
  KEY idx_arch_snapshot   (snapshotted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
