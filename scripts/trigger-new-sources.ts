/**
 * Triggers all 5 new sources (IDs 13–17) in parallel and watches for results.
 * Usage: npx tsx scripts/trigger-new-sources.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const SOURCE_IDS = [11, 12, 13, 15, 16]; // Common Ground, Riverdog, AMAM, NOYO, First Church (14=CityFresh 17=OBP are 403-blocked/disabled)
const TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 4000;

async function triggerOne(
  client: Anthropic,
  conn: mysql.Connection,
  environmentId: string,
  sourceId: number,
): Promise<void> {
  // Load source
  const [[source]] = await conn.query(
    'SELECT id, name, agent_id FROM sources WHERE id = ? AND active = 1', [sourceId]
  ) as any;
  if (!source) { console.log(`[${sourceId}] source not found, skipping`); return; }

  const name = source.name as string;
  const agentId = source.agent_id as string;

  // Create run record
  const [runRes] = await conn.query(
    "INSERT INTO agent_runs (source_id, status, started_at) VALUES (?, 'running', NOW())", [sourceId]
  ) as any;
  const runId: number = runRes.insertId;

  console.log(`[${name}] run=${runId} — starting session...`);

  let session: any;
  try {
    session = await (client.beta.sessions as any).create({
      agent: agentId,
      environment_id: environmentId,
    });
  } catch (err: any) {
    console.error(`[${name}] session create failed: ${err.message}`);
    await conn.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([err.message]), runId]
    );
    return;
  }

  console.log(`[${name}] run=${runId} session=${session.id} — polling...`);

  await (client.beta.sessions as any).events.send(session.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: 'Run extraction now. Return only the JSON array of events.' }] }],
  });

  const deadline = Date.now() + TIMEOUT_MS;
  let afterCreatedAt: string | undefined;
  let done = false;

  while (!done) {
    if (Date.now() > deadline) {
      console.error(`[${name}] timed out`);
      await conn.query(
        `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
        [JSON.stringify(['Timed out after 30 minutes']), runId]
      );
      return;
    }

    const page = await (client.beta.sessions as any).events.list(session.id, {
      ...(afterCreatedAt ? { 'created_at[gt]': afterCreatedAt } : {}),
      limit: 100,
      order: 'asc',
    }) as any;

    for (const event of (page.data ?? [])) {
      if (event.created_at) afterCreatedAt = event.created_at;
      if (event.type === 'session.status_idle') {
        const stopReason = event.stop_reason;
        if (stopReason?.type !== 'requires_action') {
          done = true;
          break;
        }
      }
    }

    if (!done) await new Promise(r => setTimeout(r, POLL_MS));
  }

  // Fetch result from DB
  const [[run]] = await conn.query(
    'SELECT events_found, events_extracted, events_skipped_dup, status FROM agent_runs WHERE id = ?', [runId]
  ) as any;

  // Mark completed if still running (ingest endpoint may have already done it)
  if (run?.status === 'running') {
    await conn.query(
      `UPDATE agent_runs SET status='completed', finished_at=NOW() WHERE id=?`, [runId]
    );
  }

  const extracted = run?.events_extracted ?? '?';
  const found = run?.events_found ?? '?';
  const skipped = run?.events_skipped_dup ?? '?';
  console.log(`[${name}] ✓ done — found=${found} extracted=${extracted} skipped=${skipped}`);
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  const environmentId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';
  if (!environmentId) throw new Error('SOURCE_BUILDER_ENVIRONMENT_ID not set');

  console.log(`Triggering ${SOURCE_IDS.length} sources in parallel...\n`);

  // Fire all in parallel
  await Promise.allSettled(
    SOURCE_IDS.map(id => triggerOne(client, conn, environmentId, id))
  );

  // Summary: show pending event counts per new source
  console.log('\n── Pending events by new source ──');
  const [rows] = await conn.query(`
    SELECT s.name, COUNT(*) AS pending
    FROM raw_events re
    JOIN sources s ON s.id = re.source_id
    WHERE re.source_id IN (${SOURCE_IDS.join(',')})
      AND re.status = 'pending'
    GROUP BY s.id, s.name
    ORDER BY s.id
  `) as any;

  if (rows.length === 0) {
    console.log('  No pending events found yet.');
  } else {
    for (const row of rows) {
      console.log(`  ${row.name}: ${row.pending} pending`);
    }
  }

  await conn.end();
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
