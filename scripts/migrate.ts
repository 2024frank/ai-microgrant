/**
 * Database migration runner.
 *
 *   npm run db:migrate           # apply all pending migrations (default: "up")
 *   npm run db:migrate:status    # show applied vs pending without changing anything
 *
 * Migrations are the *.sql files in /migrations, applied in filename order and
 * recorded in the schema_migrations table so each runs exactly once. Every
 * migration is written to be safe against an existing production database
 * (CREATE TABLE IF NOT EXISTS / idempotent MODIFY), so adopting a live DB is
 * just `npm run db:migrate`. A failing migration aborts the run and is NOT
 * recorded, so it can be fixed and retried.
 *
 * Reads DB credentials from .env.local then .env (same as the other scripts).
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');
const MIGRATION_LOCK = 'ai-microgrant-schema-migrations';

async function connect() {
  return mysql.createConnection({
    host:               process.env.DATABASE_HOST,
    port:               parseInt(process.env.DATABASE_PORT || '25060'),
    user:               process.env.DATABASE_USERNAME,
    password:           process.env.DATABASE_PASSWORD,
    database:           process.env.DATABASE_NAME,
    ssl:                { rejectUnauthorized: false },
    multipleStatements: true,
  });
}

type Conn = Awaited<ReturnType<typeof connect>>;

function migrationFiles(): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

async function ensureTrackingTable(conn: Conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function appliedVersions(conn: Conn): Promise<Set<string>> {
  const [rows] = await conn.query('SELECT version FROM schema_migrations') as any;
  return new Set((rows as any[]).map(r => r.version));
}

async function up() {
  const conn = await connect();
  let locked = false;
  try {
    const [[lock]] = await conn.query('SELECT GET_LOCK(?, 60) AS acquired', [MIGRATION_LOCK]) as any;
    locked = lock?.acquired === 1 || lock?.acquired === '1' || lock?.acquired === true;
    if (!locked) throw new Error('Timed out waiting for the schema migration lock');
    await ensureTrackingTable(conn);
    const applied = await appliedVersions(conn);
    const pending = migrationFiles().filter(f => !applied.has(f));

    if (pending.length === 0) {
      console.log('✓ Database is up to date — no pending migrations.');
      return;
    }

    console.log(`Applying ${pending.length} migration(s)…\n`);
    for (const file of pending) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      process.stdout.write(`  → ${file} … `);
      try {
        await conn.query(sql);
        await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
        console.log('done');
      } catch (err: any) {
        console.log('FAILED');
        console.error(`\nMigration ${file} failed: ${err.message}`);
        console.error('Nothing was recorded for this migration. Fix it and re-run `npm run db:migrate`.');
        throw err;
      }
    }
    console.log('\n✓ All migrations applied.');
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]).catch(() => undefined);
    await conn.end();
  }
}

async function status() {
  const conn = await connect();
  try {
    await ensureTrackingTable(conn);
    const applied = await appliedVersions(conn);
    const files = migrationFiles();
    if (files.length === 0) {
      console.log('No migration files found in /migrations.');
      return;
    }
    console.log('Migration status:\n');
    for (const file of files) {
      console.log(`  ${applied.has(file) ? '[applied]' : '[pending]'}  ${file}`);
    }
    const pending = files.filter(f => !applied.has(f)).length;
    console.log(`\n${files.length} total, ${pending} pending.`);
  } finally {
    await conn.end();
  }
}

const cmd = process.argv[2] || 'up';
const run = cmd === 'status' ? status : up;
run().catch(err => {
  console.error('migrate failed:', err.message);
  process.exit(1);
});
