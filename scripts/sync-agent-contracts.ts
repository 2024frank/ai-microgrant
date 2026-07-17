/**
 * Replace managed-agent direct-post instructions with the exact local
 * CommunityHub contract. The script is dry-run by default and never prints
 * prompt bodies or credentials. The logic lives in
 * src/lib/agentContractSync.ts and is also runnable in production via
 * POST /api/agent/sync-contracts (CRON_SECRET), because the production
 * database only accepts connections from the deployment environment.
 *
 * Usage:
 *   npx tsx scripts/sync-agent-contracts.ts
 *   npx tsx scripts/sync-agent-contracts.ts --apply
 */
import * as dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';
import { syncAgentContracts } from '../src/lib/agentContractSync';

// Re-exported for the existing unit tests and any operational tooling.
export {
  assertSafePrompt,
  buildSystemPrompt,
  sanitizeSourceInstructions,
} from '../src/lib/agentContractSync';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const APPLY = process.argv.includes('--apply');

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is required');

  const connection = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 25060),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
  });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const [rows] = await connection.query(
      `SELECT id, name, slug, agent_id, calendar_source_name
       FROM sources
       WHERE active=1 AND COALESCE(source_type, 'web') <> 'email'
         AND agent_id IS NOT NULL AND LENGTH(agent_id) > 0
       ORDER BY id`,
    ) as any;
    const sources = Array.isArray(rows) ? rows : [];

    console.log(`${APPLY ? 'Applying' : 'Dry run for'} ${sources.length} managed-agent prompt(s).`);
    const results = await syncAgentContracts({ sources, client: client as any, apply: APPLY });
    for (const result of results) {
      if (result.status === 'error') {
        console.error(`${result.slug}: FAILED ${result.error}`);
        continue;
      }
      console.log(
        `${result.slug}: ${result.status} v${result.version_before ?? '?'}${result.version_after ? ` -> v${result.version_after}` : ''} ${result.before_hash} -> ${result.after_hash} sources=${result.source_urls}`,
      );
    }
    if (results.some(result => result.status === 'error')) process.exit(1);
  } finally {
    await connection.end();
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(error => {
    console.error(`Agent prompt sync failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exit(1);
  });
}
