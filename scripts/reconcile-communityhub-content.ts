/**
 * Reconcile local `submitted` rows against CommunityHub's complete approved
 * and pending future inventory using event content, never IDs.
 *
 * Dry run (default):
 *   npx tsx scripts/reconcile-communityhub-content.ts
 *
 * Apply only after reviewing the dry-run output:
 *   npx tsx scripts/reconcile-communityhub-content.ts --apply
 */
import { createHash } from 'node:crypto';
import * as dotenv from 'dotenv';
import mysql, { type Connection } from 'mysql2/promise';
import {
  fetchCommunityHubInventory,
  findBestContentMatch,
  normalizeContentSessions,
  type ComparableEventContent,
  type CommunityHubInventory,
} from '../src/lib/communityHubInventory';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const APPLY = process.argv.includes('--apply');
const MIN_AGE_MINUTES = 60;
const LOCK_NAME = 'communityhub-content-reconcile';

type LocalRow = ComparableEventContent & {
  id: number;
  source_id: number;
  source_name: string;
  title: string;
  dedup_key: string | null;
  status: string;
  communityhub_moderation_status: string;
  updated_at: Date | string;
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ));
}

function inventoryDigest(inventory: CommunityHubInventory): string {
  const canonical = inventory.posts
    .map(post => ({
      title: post.title,
      eventType: post.eventType,
      sessions: post.sessions,
      description: post.description,
      extendedDescription: post.extendedDescription,
      calendarSourceUrl: post.calendarSourceUrl,
      moderation: post.moderation,
    }))
    .sort((left, right) => json(left).localeCompare(json(right)));
  return createHash('sha256').update(json(canonical)).digest('hex');
}

function hasCurrentSession(row: LocalRow, nowSeconds: number): boolean {
  return normalizeContentSessions(row.sessions)
    .some(session => Math.max(session.start, session.end) >= nowSeconds);
}

async function candidateRows(connection: Connection): Promise<LocalRow[]> {
  const [rows] = await connection.query(
    `SELECT re.*, s.name AS source_name
     FROM raw_events re
     JOIN sources s ON s.id=re.source_id
     WHERE re.status='submitted'
       AND re.communityhub_post_id IS NOT NULL
       AND re.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND NOT EXISTS (
         SELECT 1 FROM communityhub_updates cu
         WHERE cu.raw_event_id=re.id AND cu.status IN ('sending','ambiguous')
       )
       AND NOT EXISTS (
         SELECT 1 FROM communityhub_submissions cs
         WHERE cs.raw_event_id=re.id
           AND cs.status IN ('prepared','sending','accepted_unreconciled')
       )
     ORDER BY re.id`,
    [MIN_AGE_MINUTES],
  );
  return Array.isArray(rows) ? rows as LocalRow[] : [];
}

async function relatedSnapshot(connection: Connection, row: LocalRow) {
  const tables = [
    'field_edit_log',
    'rejection_log',
    'review_sessions',
    'communityhub_submissions',
    'communityhub_updates',
    'needs_fix',
    'notifications',
  ];
  const related: Record<string, unknown> = {};
  for (const table of tables) {
    const [records] = await connection.query(
      `SELECT * FROM \`${table}\` WHERE raw_event_id=?`,
      [row.id],
    );
    related[table] = records;
  }
  return { raw_event: row, related };
}

async function deleteCandidates(
  connection: Connection,
  rows: LocalRow[],
  inventory: CommunityHubInventory,
  digest: string,
): Promise<number> {
  const [[lock]] = await connection.query(
    'SELECT GET_LOCK(?, 0) AS acquired',
    [LOCK_NAME],
  ) as any;
  if (!(lock?.acquired === 1 || lock?.acquired === '1' || lock?.acquired === true)) {
    throw new Error('another CommunityHub content reconciliation is already running');
  }

  let deleted = 0;
  try {
    await connection.beginTransaction();
    for (const candidate of rows) {
      const [[current]] = await connection.query(
        `SELECT re.*, s.name AS source_name
         FROM raw_events re
         JOIN sources s ON s.id=re.source_id
         WHERE re.id=? AND re.status='submitted'
         LIMIT 1 FOR UPDATE`,
        [candidate.id],
      ) as any;
      if (!current) continue;
      const currentMatch = findBestContentMatch(current, inventory.posts);
      if (currentMatch.kind !== 'none') continue;
      if (new Date(current.updated_at).getTime() !== new Date(candidate.updated_at).getTime()) {
        continue;
      }

      const snapshot = await relatedSnapshot(connection, current);
      await connection.query(
        `INSERT INTO communityhub_reconciliation_deletions
         (raw_event_id, source_id, event_title, dedup_key, reason,
          event_snapshot, remote_inventory_sha256,
          remote_approved_count, remote_pending_count)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          current.id,
          current.source_id,
          current.title,
          current.dedup_key,
          'absent_from_complete_approved_pending_content_inventory',
          json(snapshot),
          digest,
          inventory.approved,
          inventory.pending,
        ],
      );
      // These legacy tables intentionally have no raw_events foreign key.
      await connection.query('DELETE FROM needs_fix WHERE raw_event_id=?', [current.id]);
      await connection.query('DELETE FROM notifications WHERE raw_event_id=?', [current.id]);
      await connection.query('DELETE FROM communityhub_submissions WHERE raw_event_id=?', [current.id]);
      // FK-backed edit/review/update rows are removed by raw_events cascades.
      await connection.query(
        `DELETE FROM raw_events
         WHERE id=? AND status='submitted'`,
        [current.id],
      );
      deleted++;
    }
    await connection.commit();
    return deleted;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
  }
}

async function main() {
  const required = [
    'DATABASE_HOST',
    'DATABASE_NAME',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
  ];
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`database environment is incomplete: ${missing.join(', ')}`);
  }

  // Fetch and validate the complete remote snapshot before opening a mutation
  // transaction. An HTTP error, unknown moderation value, missing page, or
  // count mismatch aborts the script and can never become deletion evidence.
  const inventory = await fetchCommunityHubInventory();
  const digest = inventoryDigest(inventory);
  console.log(
    `CommunityHub inventory: ${inventory.approved} approved, ${inventory.pending} pending, ${inventory.pages} page(s), digest ${digest.slice(0, 12)}`,
  );

  const connection = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 25060),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const rows = await candidateRows(connection);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentRows = rows.filter(row => hasCurrentSession(row, nowSeconds));
    const reports = currentRows.map(row => ({
      row,
      match: findBestContentMatch(row, inventory.posts),
    }));
    const absent = reports.filter(report => report.match.kind === 'none').map(report => report.row);

    console.log(
      `Eligible waiting rows: ${currentRows.length}; exact content matches: ${reports.filter(report => report.match.kind === 'exact').length}; probable matches retained: ${reports.filter(report => report.match.kind === 'probable').length}; proven absent: ${absent.length}`,
    );
    for (const report of reports) {
      const starts = normalizeContentSessions(report.row.sessions).map(session => session.start).join(',');
      console.log(
        `${report.match.kind.toUpperCase()} | ${report.row.source_name} | ${report.row.title} | sessions=${starts || 'none'}${report.match.reasons.length ? ` | ${report.match.reasons.join(', ')}` : ''}`,
      );
    }

    if (!APPLY) {
      console.log('Dry run only. No database rows were deleted.');
      return;
    }
    const deleted = await deleteCandidates(connection, absent, inventory, digest);
    console.log(`Deleted ${deleted} proven-absent submitted row(s) after archiving each snapshot.`);
  } finally {
    await connection.end();
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(error => {
    console.error(
      `CommunityHub content reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exit(1);
  });
}
