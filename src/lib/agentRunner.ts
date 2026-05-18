import Anthropic from '@anthropic-ai/sdk';
import pool from './db';
import { getRejectionHistory } from './rejectionHistory';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function triggerAgentRun(sourceId: number) {
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE id = ? AND active = 1', [sourceId]
  ) as any;
  if (!source) throw new Error(`Source ${sourceId} not found or inactive`);

  // Find or create a run record
  let runId: number;
  const [[existingRun]] = await pool.query(
    `SELECT id FROM agent_runs WHERE source_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1`,
    [sourceId]
  ) as any;

  if (existingRun) {
    runId = existingRun.id;
  } else {
    const [runResult] = await pool.query(
      'INSERT INTO agent_runs (source_id, status) VALUES (?, "running")', [sourceId]
    ) as any;
    runId = runResult.insertId;
  }

  try {
    const { prompt_block } = await getRejectionHistory(sourceId, 50);

    // Call the Claude agent
    const message = await (client.beta as any).agents.runSession({
      agent_id:       source.agent_id,
      environment_id: process.env.SOURCE_BUILDER_ENVIRONMENT_ID,
      vault_id:       process.env.SOURCE_BUILDER_VAULT_ID,
      messages: [{
        role: 'user',
        content: prompt_block
          ? `Run extraction now.\n\n${prompt_block}\n\nReturn only the JSON array of events.`
          : 'Run extraction now. Return only the JSON array of events.',
      }],
    });

    // Extract JSON from response
    const text = (message?.content || [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('Agent returned no JSON array — check agent instructions');

    const events: any[] = JSON.parse(jsonMatch[0]);
    const inserted = await writeEvents(events, sourceId, runId, source.calendar_source_name);

    await pool.query(
      `UPDATE agent_runs SET status='completed', finished_at=NOW(), events_extracted=?, events_found=? WHERE id=?`,
      [inserted.length, events.length, runId]
    );

    return { run_id: runId, inserted: inserted.length, events: inserted };

  } catch (err: any) {
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=? WHERE id=?`,
      [JSON.stringify([err.message]), runId]
    );
    throw err;
  }
}

async function writeEvents(events: any[], sourceId: number, runId: number, calendarSourceName: string) {
  const inserted: any[] = [];
  const conn = await pool.getConnection();
  try {
    await (conn as any).beginTransaction();
    for (const ev of events) {
      const [res] = await conn.query(
        `INSERT INTO raw_events (
          source_id, agent_run_id, event_type, title, description,
          extended_description, sponsors, post_type_ids, sessions,
          location_type, location, place_id, place_name, room_num,
          url_link, display, screen_ids, buttons, contact_email,
          phone, website, image_cdn_url, calendar_source_name,
          calendar_source_url, geo_scope, geo_json, status
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending')`,
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
          ev.contactEmail     || null,
          ev.phone            || null,
          ev.website          || null,
          ev.image_cdn_url    || null,
          ev.calendarSourceName || calendarSourceName,
          ev.calendarSourceUrl  || null,
          ev.geo_scope        || null,
          ev.geo ? JSON.stringify(ev.geo) : null,
        ]
      ) as any;
      const eventId = res.insertId;
      const ingestedPostUrl = `${process.env.NEXT_PUBLIC_APP_URL}/events/${eventId}`;
      await conn.query('UPDATE raw_events SET ingested_post_url = ? WHERE id = ?', [ingestedPostUrl, eventId]);
      inserted.push({ id: eventId, title: ev.title });
    }
    await (conn as any).commit();
    return inserted;
  } catch (e) {
    await (conn as any).rollback();
    throw e;
  } finally {
    (conn as any).release();
  }
}
