/**
 * Seed script — run once to create the initial admin users.
 * Usage: npx ts-node --project tsconfig.json scripts/seed-admins.ts
 * Or: npx tsx scripts/seed-admins.ts
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import mysql from 'mysql2/promise';

async function seed() {
  const pool = await mysql.createConnection({
    host:               process.env.DATABASE_HOST,
    port:               parseInt(process.env.DATABASE_PORT || '25060'),
    user:               process.env.DATABASE_USERNAME,
    password:           process.env.DATABASE_PASSWORD,
    database:           process.env.DATABASE_NAME,
    ssl:                { rejectUnauthorized: true },
  });

  const admins = [
    { email: 'aca@communityhub.cloud', full_name: 'ACA Admin',   role: 'admin' },
    { email: 'fkusiapp@oberlin.edu',   full_name: 'Frank Kusi',   role: 'admin' },
  ];

  for (const admin of admins) {
    const [existing] = await pool.query(
      'SELECT id FROM users WHERE email = ?', [admin.email]
    ) as any;

    if (existing.length > 0) {
      console.log(`✓ Already exists: ${admin.email}`);
      continue;
    }

    await pool.query(
      `INSERT INTO users (email, full_name, role, active, firebase_uid)
       VALUES (?, ?, ?, 1, NULL)`,
      [admin.email, admin.full_name, admin.role]
    );
    console.log(`✓ Created admin: ${admin.email}`);
  }

  await pool.end();
  console.log('\nDone. Both users can now sign in with Google.');
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
