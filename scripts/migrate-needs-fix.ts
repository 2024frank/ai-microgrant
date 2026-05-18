import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
    multipleStatements: true,
  });

  console.log('Running needs_fix migration…');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS needs_fix (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      raw_event_id   INT NOT NULL,
      source_id      INT NOT NULL,
      correction_notes TEXT NOT NULL,
      sent_by_user_id  INT NULL,
      sent_by_email    VARCHAR(255) NULL,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_event (raw_event_id)
    )
  `);
  console.log('✓ needs_fix table ready');

  await conn.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      user_id      INT NOT NULL,
      type         VARCHAR(50) NOT NULL DEFAULT 'event_fixed',
      title        VARCHAR(255),
      message      TEXT,
      raw_event_id INT NULL,
      read_at      TIMESTAMP NULL,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_unread (user_id, read_at)
    )
  `);
  console.log('✓ notifications table ready');

  // Add columns to raw_events (ignore error if already exist)
  for (const sql of [
    "ALTER TABLE raw_events ADD COLUMN sent_for_correction TINYINT(1) NOT NULL DEFAULT 0",
    "ALTER TABLE raw_events ADD COLUMN corrected_from_id INT NULL",
    "ALTER TABLE raw_events ADD COLUMN sent_for_fix_by VARCHAR(255) NULL",
  ]) {
    try {
      await conn.query(sql);
      console.log(`✓ ${sql.slice(0, 60)}`);
    } catch (e: any) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log(`  (already exists — skipped)`);
      else throw e;
    }
  }

  // Create the "Fixed Events" source if it doesn't exist
  const [[existing]] = await conn.query(
    "SELECT id FROM sources WHERE slug = 'fixed-events'"
  ) as any;
  if (!existing) {
    await conn.query(
      `INSERT INTO sources (name, slug, agent_prompt, active, calendar_source_name)
       VALUES ('Fixed Events', 'fixed-events', '', 1, 'Fixed Events')`
    );
    console.log('✓ "Fixed Events" source created');
  } else {
    console.log('  "Fixed Events" source already exists');
  }

  await conn.end();
  console.log('\nDone.');
}

main().catch(err => { console.error('Migration failed:', err.message); process.exit(1); });
