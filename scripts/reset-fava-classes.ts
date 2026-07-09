/**
 * Deletes pending FAVA class/workshop/camp events that have no extendedDescription
 * (generated before the prompt fix). Safe to re-ingest after running this.
 *
 * Usage: npx tsx scripts/reset-fava-classes.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(`
    SELECT re.id, re.title, re.status
    FROM raw_events re JOIN sources s ON s.id = re.source_id
    WHERE s.slug = 'fava'
      AND re.status = 'pending'
      AND (re.extended_description IS NULL OR re.extended_description = '')
    ORDER BY re.id
  `) as any;

  if ((rows as any[]).length === 0) {
    console.log('Nothing to delete.');
    await conn.end();
    return;
  }

  console.log('Will delete:');
  for (const r of rows as any[]) console.log(' #' + r.id, r.title);

  const ids = (rows as any[]).map((r: any) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  const [result] = await conn.query(
    `DELETE FROM raw_events WHERE id IN (${placeholders})`,
    ids
  ) as any;

  console.log(`\nDeleted ${result.affectedRows} events. Re-ingest FAVA to regenerate with proper descriptions.`);
  await conn.end();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
