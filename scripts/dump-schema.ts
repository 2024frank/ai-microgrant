/**
 * Dump the LIVE database schema (DDL only, no data) to schema.snapshot.sql.
 *
 *   npm run db:dump-schema
 *
 * Use this to capture what production actually looks like, then diff it against
 * migrations/0001_baseline.sql to confirm the reconstructed schema matches
 * reality (or to discover columns/tables added out-of-band). It only reads
 * (SHOW TABLES / SHOW CREATE TABLE) — it never modifies the database.
 *
 * Reads DB credentials from .env.local then .env.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

const OUT = join(process.cwd(), 'schema.snapshot.sql');

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [tables] = await conn.query('SHOW FULL TABLES WHERE Table_type = "BASE TABLE"') as any;
  const names = (tables as any[]).map(row => Object.values(row)[0] as string).sort();

  const parts: string[] = [
    '-- ============================================================',
    `-- Live schema snapshot — ${process.env.DATABASE_NAME ?? '(db)'}`,
    `-- Generated ${new Date().toISOString()} by scripts/dump-schema.ts`,
    '-- Read-only capture of production DDL. Diff against',
    '-- migrations/0001_baseline.sql to reconcile the reconstructed schema.',
    '-- ============================================================',
    '',
  ];

  for (const name of names) {
    const [[row]] = await conn.query(`SHOW CREATE TABLE \`${name}\``) as any;
    const ddl = row['Create Table'] ?? row['Create View'];
    parts.push(`-- ---- ${name} ----`, `${ddl};`, '');
  }

  await conn.end();

  writeFileSync(OUT, parts.join('\n'), 'utf8');
  console.log(`✓ Wrote ${names.length} table definition(s) to ${OUT}`);
  console.log('  Next: diff schema.snapshot.sql against migrations/0001_baseline.sql');
}

main().catch(err => {
  console.error('dump-schema failed:', err.message);
  process.exit(1);
});
