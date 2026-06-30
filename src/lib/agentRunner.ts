import Anthropic from '@anthropic-ai/sdk';
import pool from './db';
import { getRejectionHistory } from './rejectionHistory';
import { computeDedupKey } from './eventDedup';
import { getAdminContact } from './adminContact';

function getClient(apiKey: string) {
  // In test env the SDK is mocked — don't throw on missing key
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  return new Anthropic({ apiKey: key });
}

/**
 * Trigger a Claude agent run for a given source.
 * Uses the Sessions long-poll API — no arbitrary timeout, completes exactly
 * when the agent fires session.status_idle.
 *
 * @param sourceId       DB id of the sources row
 * @param runId          Pre-created agent_runs row id (from the trigger route)
 * @param anthropicKey   ANTHROPIC_API_KEY forwarded from the route handler
 * @param environmentId  SOURCE_BUILDER_ENVIRONMENT_ID forwarded from the route handler
 */
export async function triggerAgentRun(
  sourceId: number,
  runId: number,
  anthropicKey: string,
  environmentId: string,
  overrideUserMessage?: string,
) {
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE id = ? AND active = 1', [sourceId]
  ) as any;
  if (!source) throw new Error(`Source ${sourceId} not found or inactive`);

  try {
    // Get rejection history for this source → injected so agent learns from mistakes
    const { prompt_block } = await getRejectionHistory(sourceId, 50);

    // Trigger the agent via Anthropic's managed-agents Sessions API.
    // Each source has its own agent_id; environment and vault are shared.
    const userMessage = overrideUserMessage ?? (
      prompt_block
        ? `Run extraction now.\n\n${prompt_block}\n\nReturn only the JSON array of events.`
        : 'Run extraction now. Return only the JSON array of events.'
    );

    const client = getClient(anthropicKey);

    // 1. Create a session for this agent
    const session = await client.beta.sessions.create({
      agent:          source.agent_id,
      environment_id: environmentId,
    } as any);

    // Persist the session id so a stop request can tear it down API-side
    // (the SDK has no cancel — delete is the only teardown). Best-effort.
    await pool.query('UPDATE agent_runs SET session_id = ? WHERE id = ?', [session.id, runId]).catch(() => {});

    // 2. Send the user message to trigger the agent
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: userMessage }] }],
    } as any);

    // 3. Long-poll events.list() with created_at[gt] cursor until session.status_idle.
    //    No arbitrary timeout — completes as soon as the agent is done regardless of
    //    how long the extraction takes.
    console.log(`[agentRunner] run=${runId} session=${session.id} polling start`);
    const outputChunks: string[] = [];
    let afterCreatedAt: string | undefined;
    let done = false;
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
    const deadline = Date.now() + TIMEOUT_MS;

    while (!done) {
      if (Date.now() > deadline) {
        throw new Error(`Agent run timed out after 30 minutes (session ${session.id})`);
      }

      // Check if this run was stopped externally before each poll
      const [[currentRun]] = await pool.query(
        'SELECT status FROM agent_runs WHERE id = ?', [runId]
      ) as any;
      if (currentRun?.status === 'stopped') {
        console.log(`[agentRunner] run=${runId} stopped externally — aborting`);
        return { run_id: runId, inserted: 0, events: [] };
      }

      const page = await client.beta.sessions.events.list(session.id, {
        ...(afterCreatedAt ? { 'created_at[gt]': afterCreatedAt } : {}),
        limit: 100,
        order: 'asc',
      } as any) as any;

      const events: any[] = page.data ?? [];

      for (const event of events) {
        if (event.created_at) afterCreatedAt = event.created_at;

        if (event.type === 'agent.message') {
          for (const block of (event.content ?? []) as any[]) {
            if (block.type === 'text' && block.text) {
              outputChunks.push(block.text);
            }
          }
        }

        if (event.type === 'session.status_idle') {
          const stopReason = event.stop_reason;
          if (stopReason?.type !== 'requires_action') {
            console.log(`[agentRunner] run=${runId} session idle — extraction complete`);
            done = true;
            break;
          }
        }
      }

      // Brief delay between every poll to avoid hammering the Sessions API
      if (!done) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    const outputText = outputChunks.join('');

    const jsonMatch = outputText.match(/\[[\s\S]*\]/);

    // Some agents (e.g. fix agent) submit events directly via the ingest HTTP endpoint
    // rather than returning a JSON array — treat no-JSON as a successful direct-post run.
    if (!jsonMatch) {
      await pool.query(
        `UPDATE agent_runs SET status='completed', finished_at=NOW(),
         events_found=0, events_extracted=0 WHERE id=?`,
        [runId]
      );
      return { run_id: runId, inserted: 0, events: [] };
    }

    let events: any[];
    try {
      events = JSON.parse(jsonMatch[0]);
    } catch {
      // Malformed JSON match — treat as no-output run
      await pool.query(
        `UPDATE agent_runs SET status='completed', finished_at=NOW(),
         events_found=0, events_extracted=0 WHERE id=?`,
        [runId]
      );
      return { run_id: runId, inserted: 0, events: [] };
    }

    // Write events to MySQL
    const { inserted, skipped } = await writeEvents(events, sourceId, runId, source.calendar_source_name);

    // Close run with stats
    await pool.query(
      `UPDATE agent_runs SET
         status='completed', finished_at=NOW(),
         events_found=?, events_extracted=?, events_skipped_dup=?
       WHERE id=?`,
      [events.length, inserted.length, skipped, runId]
    );

    return { run_id: runId, inserted: inserted.length, skipped, events: inserted };

  } catch (err: any) {
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([err.message]), runId]
    );
    throw err;
  }
}

async function writeEvents(events: any[], sourceId: number, runId: number, calendarSourceName: string) {
  const adminContact = await getAdminContact();
  const inserted: any[] = [];
  let skipped = 0;
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();

    for (const ev of events) {
      // Skip an event already ingested for this source with the same title +
      // session window (agent re-scraped something already in the system).
      const dedupKey = computeDedupKey(ev.title, ev.sessions, ev.eventType, ev.description, ev.extendedDescription);
      const [dupRows] = await conn.query(
        "SELECT id FROM raw_events WHERE source_id = ? AND dedup_key = ? AND status IN ('pending','approved','pending_fix') LIMIT 1",
        [sourceId, dedupKey]
      ) as any;
      if (Array.isArray(dupRows) && dupRows.length > 0) { skipped++; continue; }

      // image_data stores base64; image_cdn_url will be set to /api/events/{id}/poster.jpg after INSERT
      const rawImageUrl: string | null = ev.image_cdn_url || null;
      const rawImageData: string | null = rawImageUrl?.startsWith('data:') ? rawImageUrl : null;
      // If the agent passed a plain URL (not base64), keep it; otherwise null (set after INSERT)
      const storedCdnUrl: string | null = rawImageUrl && !rawImageUrl.startsWith('data:') ? rawImageUrl : null;

      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email, email,
          phone, website, image_cdn_url, image_data, calendar_source_name,
          calendar_source_url, geo_scope, geo_json, dedup_key, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
        [
          sourceId, runId,
          ev.eventType        || 'ot',
          ev.title,
          ev.description,
          ev.extendedDescription  || null,
          JSON.stringify(ev.sponsors     || []),
          JSON.stringify(ev.postTypeId   || []),
          JSON.stringify(ev.sessions     || []),
          ev.locationType     || 'ne',
          ev.location         || null,
          ev.placeId          || null,
          ev.placeName        || null,
          ev.roomNum          || null,
          ev.urlLink          || null,
          ev.display          || 'all',
          JSON.stringify(ev.screensIds   || []),
          JSON.stringify(ev.buttons      || []),
          adminContact        || ev.contactEmail || null,
          adminContact        || ev.email        || null,
          ev.phone            || null,
          ev.website          || null,
          storedCdnUrl,
          rawImageData,
          ev.calendarSourceName || calendarSourceName,
          ev.calendarSourceUrl  || null,
          ev.geo_scope        || null,
          ev.geo ? JSON.stringify(ev.geo) : null,
          dedupKey,
        ]
      ) as any;

      const eventId = res.insertId;
      const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

      const ingestedPostUrl = `${appUrl}/events/${eventId}`;
      // Set image_cdn_url to serving URL with .jpg extension — CH validates the extension
      const servingImageUrl = rawImageData ? `${appUrl}/api/events/${eventId}/poster.jpg` : null;
      await conn.query(
        'UPDATE raw_events SET ingested_post_url = ?, image_cdn_url = COALESCE(?, image_cdn_url) WHERE id = ?',
        [ingestedPostUrl, servingImageUrl, eventId]
      );

      inserted.push({ id: eventId, title: ev.title, ingested_post_url: ingestedPostUrl });
    }

    await (conn as any).commit();
    return { inserted, skipped };
  } catch (e) {
    await (conn as any).rollback();
    throw e;
  } finally {
    (conn as any).release();
  }
}
