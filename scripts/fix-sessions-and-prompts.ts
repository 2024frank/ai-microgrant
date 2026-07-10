/**
 * 1. Migrates existing raw_events sessions from ISO 8601 strings → Unix timestamps (seconds)
 *    for all events from new sources (IDs 11-16).
 * 2. Updates live agent system prompts to say "Unix timestamps in SECONDS" instead of ISO 8601.
 *
 * Usage: npx tsx scripts/fix-sessions-and-prompts.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

function isoToUnix(val: string | number): number | undefined {
  if (typeof val === 'number') return val; // already Unix
  const ms = new Date(val).getTime();
  if (isNaN(ms)) return undefined;
  return Math.floor(ms / 1000);
}

async function migrateSessions(conn: mysql.Connection) {
  const [rows] = await conn.query(`
    SELECT id, sessions FROM raw_events
    WHERE source_id IN (11,12,13,15,16)
      AND status = 'pending'
  `) as any;

  let fixed = 0, skipped = 0;
  for (const row of rows) {
    const sessions = Array.isArray(row.sessions) ? row.sessions : [];
    let changed = false;
    const updated = sessions.map((s: any) => {
      const st = isoToUnix(s.startTime);
      const et = isoToUnix(s.endTime);
      if (st !== s.startTime || et !== s.endTime) changed = true;
      return { ...s, startTime: st ?? s.startTime, endTime: et ?? s.endTime };
    });
    if (changed) {
      await conn.query('UPDATE raw_events SET sessions = ? WHERE id = ?', [JSON.stringify(updated), row.id]);
      fixed++;
    } else {
      skipped++;
    }
  }
  console.log(`Sessions migrated: ${fixed} fixed, ${skipped} already Unix`);
}

async function updateAgentPrompt(client: Anthropic, agentId: string, label: string) {
  const current = await (client.beta.agents as any).retrieve(agentId);
  const oldSystem: string = current.system ?? '';

  // Replace ISO 8601 UTC → Unix seconds in sessions field description
  const newSystem = oldSystem.replace(
    /sessions[^\n]*ISO 8601 UTC[^\n]*/g,
    (match) => match.replace('ISO 8601 UTC', 'Unix timestamps in SECONDS (integer) — e.g. 1754139600 for Aug 2 2026 10:00 AM ET')
  );

  if (newSystem === oldSystem) {
    console.log(`  ${label}: no change needed`);
    return;
  }

  await (client.beta.agents as any).update(agentId, {
    version: current.version,
    system: newSystem,
  });
  console.log(`  ${label}: ✓ updated`);
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
  });

  // ── 1. Migrate sessions in DB ───────────────────────────────────────────────
  console.log('Migrating sessions ISO → Unix...');
  await migrateSessions(conn);

  // ── 2. Update live agent prompts ────────────────────────────────────────────
  console.log('\nUpdating live agent prompts...');
  const [sources] = await conn.query(
    'SELECT id, name, agent_id FROM sources WHERE id IN (11,12,13,15,16) AND agent_id IS NOT NULL ORDER BY id'
  ) as any;

  for (const src of sources) {
    await updateAgentPrompt(client, src.agent_id, `${src.name} (id=${src.id})`);
  }

  await conn.end();
  console.log('\nDone.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
