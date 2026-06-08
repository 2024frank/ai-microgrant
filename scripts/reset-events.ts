/**
 * Stops all running agent runs and clears all event data.
 * Preserves: users, sources, reviewer_sources.
 * Usage: npx tsx scripts/reset-events.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';

async function reset() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  try {
    await conn.beginTransaction();

    // 1. Stop all running agent runs
    const [stopped] = await conn.query(
      `UPDATE agent_runs SET status = 'failed', finished_at = NOW()
       WHERE status = 'running'`
    ) as any;
    console.log(`Stopped ${stopped.affectedRows} running agent run(s)`);

    // 2. Clear event data (order respects FK constraints)
    await conn.query('DELETE FROM review_sessions');
    await conn.query('DELETE FROM field_edit_log');
    await conn.query('DELETE FROM rejection_log');
    await conn.query('DELETE FROM raw_events');
    await conn.query('DELETE FROM agent_runs');

    // 3. Reset auto-increment counters
    await conn.query('ALTER TABLE review_sessions AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE field_edit_log AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE rejection_log AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE raw_events AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE agent_runs AUTO_INCREMENT = 1');

    await conn.commit();
    console.log('Done — all event data cleared. Users, sources, and assignments preserved.');
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
}

reset().catch(err => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
