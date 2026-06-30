/**
 * Remove duplicate events already in the DB, using the same rule as ingest:
 * announcements de-dupe on short description + extended description + sessions;
 * events on title + sessions (see lib/eventDedup.ts). Within each duplicate
 * group it KEEPS one row — preferring an approved/posted row, else the oldest —
 * and deletes only the redundant PENDING / pending_fix rows (never an approved
 * one, so nothing published to CommunityHub is touched).
 *
 *   npx tsx scripts/dedupe-events.ts            # dry run (shows what it would do)
 *   npx tsx scripts/dedupe-events.ts --apply    # actually delete
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';
import { computeDedupKey } from '../src/lib/eventDedup';

const APPLY = process.argv.includes('--apply');

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT id, source_id, event_type, title, description, extended_description,
            sessions, status, communityhub_post_id
     FROM raw_events
     WHERE status IN ('pending','approved','pending_fix')
     ORDER BY id`
  ) as any;

  const groups = new Map<string, any[]>();
  for (const r of rows as any[]) {
    let sessions = r.sessions;
    if (typeof sessions === 'string') { try { sessions = JSON.parse(sessions); } catch { sessions = []; } }
    const key = computeDedupKey(r.title, sessions, r.event_type, r.description, r.extended_description);
    const gk = `${r.source_id}::${key}`;
    (groups.get(gk) ?? groups.set(gk, []).get(gk)!).push(r);
  }

  const toDelete: any[] = [];
  let dupGroups = 0;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    dupGroups++;
    const approved = members.filter(m => m.status === 'approved' || m.communityhub_post_id);
    const keeper = (approved.length ? approved : members).reduce((a, b) => (a.id <= b.id ? a : b));
    for (const m of members) {
      if (m.id !== keeper.id && (m.status === 'pending' || m.status === 'pending_fix')) toDelete.push(m);
    }
  }

  console.log(`Live events: ${(rows as any[]).length}`);
  console.log(`Duplicate groups: ${dupGroups}`);
  console.log(`Redundant pending rows to remove: ${toDelete.length}\n`);
  for (const m of toDelete.slice(0, 40)) {
    console.log(`  DELETE #${m.id} [${m.status}] src=${m.source_id}  "${String(m.title).slice(0, 55)}"`);
  }
  if (toDelete.length > 40) console.log(`  ... and ${toDelete.length - 40} more`);

  if (!APPLY) { console.log('\nDry run — re-run with --apply to delete.'); await conn.end(); return; }

  let deleted = 0;
  for (let i = 0; i < toDelete.length; i += 500) {
    const ids = toDelete.slice(i, i + 500).map(m => m.id);
    const [res] = await conn.query(
      `DELETE FROM raw_events WHERE id IN (${ids.map(() => '?').join(',')})`, ids
    ) as any;
    deleted += res.affectedRows;
  }
  console.log(`\nDeleted ${deleted} duplicate rows.`);
  await conn.end();
}

main().catch(e => { console.error('dedupe failed:', e.message); process.exit(1); });
