import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import pool from '@/lib/db';
import { cronUnavailable, isCronAuthorized } from '@/lib/cronAuth';
import { syncAgentContracts } from '@/lib/agentContractSync';

export const maxDuration = 300;

/**
 * POST /api/agent/sync-contracts (CRON_SECRET)
 *
 * Rewrites every active managed agent's system prompt with the canonical
 * extraction contract, including the corrected category taxonomy that fixes
 * the phantom-category bug (2026-07-16 meeting, item 2). Runs here because
 * the production database only accepts deployment-environment connections.
 * Dry run by default; pass ?apply=1 to write. Responses contain only prompt
 * hashes, never prompt bodies.
 */
export async function POST(req: NextRequest) {
  if (cronUnavailable()) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!isCronAuthorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json({ error: 'ANTHROPIC_API_KEY is not configured' }, { status: 503 });
  }

  const apply = new URL(req.url).searchParams.get('apply') === '1';
  const [rows] = await pool.query(
    `SELECT id, name, slug, agent_id, calendar_source_name
     FROM sources
     WHERE active=1 AND COALESCE(source_type, 'web') <> 'email'
       AND agent_id IS NOT NULL AND LENGTH(agent_id) > 0
     ORDER BY id`,
  ) as any;
  const sources = Array.isArray(rows) ? rows : [];
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const results = await syncAgentContracts({ sources, client: client as any, apply });

  return Response.json({
    ok: results.every(result => result.status !== 'error'),
    apply,
    checked: sources.length,
    updated: results.filter(result => result.status === 'updated').length,
    would_update: results.filter(result => result.status === 'would_update').length,
    unchanged: results.filter(result => result.status === 'unchanged').length,
    errors: results.filter(result => result.status === 'error').length,
    results,
  });
}
