/**
 * One-time patch: set phone + contact_email on all Apollo events.
 * Usage: npx tsx scripts/patch-apollo-contacts.ts
 */

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
  });

  const [sources] = await conn.query(
    "SELECT id, name, slug FROM sources WHERE name LIKE '%Apollo%' OR slug LIKE '%apollo%'"
  ) as any;

  if (!sources.length) {
    console.error('No Apollo source found. Check that the source name contains "Apollo".');
    await conn.end();
    process.exit(1);
  }

  for (const source of sources) {
    console.log(`Found source: "${source.name}" (id=${source.id}, slug=${source.slug})`);

    const [result] = await conn.query(
      'UPDATE raw_events SET phone = ?, contact_email = ? WHERE source_id = ?',
      ['440-774-3920', 'apollo@clevelandcinemas.com', source.id]
    ) as any;

    console.log(`  ✓ Updated ${result.affectedRows} events`);
  }

  await conn.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Patch failed:', err.message);
  process.exit(1);
});
