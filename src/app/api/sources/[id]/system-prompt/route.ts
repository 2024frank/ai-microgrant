import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import pool from '@/lib/db';
import { getAuthUser, unauthorized, forbidden } from '@/lib/auth';

function client() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

/**
 * GET /api/sources/:id/system-prompt
 * Fetches the current system prompt and version from the Anthropic Agents API.
 */
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await context.params;

  const [[source]] = await pool.query(
    'SELECT id, name, agent_id FROM sources WHERE id = ?', [id]
  ) as any;
  if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });
  if (!source.agent_id) return Response.json({ error: 'Source has no agent_id' }, { status: 400 });

  try {
    const agent = await client().beta.agents.retrieve(source.agent_id);
    return Response.json({
      agent_id: agent.id,
      name:     agent.name,
      system:   agent.system ?? '',
      version:  agent.version,
    });
  } catch (err: any) {
    return Response.json({ error: `Anthropic API error: ${err.message}` }, { status: 502 });
  }
}

/**
 * PATCH /api/sources/:id/system-prompt
 * Updates the system prompt on the Anthropic Agents API.
 * Body: { system: string, version: number }
 */
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const user = await getAuthUser(req);
  if (!user) return unauthorized();
  if (user.role !== 'admin') return forbidden();

  const { id } = await context.params;

  const [[source]] = await pool.query(
    'SELECT id, name, agent_id FROM sources WHERE id = ?', [id]
  ) as any;
  if (!source) return Response.json({ error: 'Source not found' }, { status: 404 });
  if (!source.agent_id) return Response.json({ error: 'Source has no agent_id' }, { status: 400 });

  let body: any;
  try { body = await req.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { system, version } = body;
  if (typeof system !== 'string') return Response.json({ error: 'system must be a string' }, { status: 422 });
  if (typeof version !== 'number') return Response.json({ error: 'version is required' }, { status: 422 });

  try {
    const updated = await client().beta.agents.update(source.agent_id, { version, system });
    return Response.json({
      ok:      true,
      version: updated.version,
      system:  updated.system ?? '',
    });
  } catch (err: any) {
    // version conflict = 409
    const status = err.status === 409 ? 409 : 502;
    return Response.json({ error: `Anthropic API error: ${err.message}` }, { status });
  }
}
