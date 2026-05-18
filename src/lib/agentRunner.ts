import Anthropic from '@anthropic-ai/sdk';
import pool from './db';
import { getRejectionHistory } from './rejectionHistory';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export async function triggerAgentRun(sourceId: number) {
  const [[source]] = await pool.query(
    'SELECT * FROM sources WHERE id = ? AND active = 1', [sourceId]
  ) as any;
  if (!source) throw new Error(`Source ${sourceId} not found or inactive`);

  // Find existing running record or create one
  const [[existingRun]] = await pool.query(
    `SELECT id FROM agent_runs WHERE source_id = ? AND status = 'running'
     ORDER BY started_at DESC LIMIT 1`, [sourceId]
  ) as any;

  let runId: number;
  if (existingRun) {
    runId = existingRun.id;
  } else {
    const [r] = await pool.query(
      'INSERT INTO agent_runs (source_id, status) VALUES (?, "running")', [sourceId]
    ) as any;
    runId = r.insertId;
  }

  try {
    const { prompt_block } = await getRejectionHistory(sourceId, 50);

    const triggerMessage = prompt_block
      ? `Run the full extraction pipeline and return the JSON array.\n\n${prompt_block}`
      : 'Run the full extraction pipeline and return the JSON array.';

    // Create a session for this agent
    const session = await (client.beta as any).sessions.create({
      agent:          source.agent_id,
      environment_id: process.env.SOURCE_BUILDER_ENVIRONMENT_ID,
      title:          `${source.name} extraction run`,
    });

    // Send message and stream response
    const fullText: string[] = [];
    let fetchCount = 0;

    // Send trigger message in background
    const sendMsg = (client.beta as any).sessions.events.send(
      session.id,
      {
        events: [{
          type:    'user.message',
          content: [{ type: 'text', text: triggerMessage }],
        }],
      }
    );

    // Stream events
    await new Promise<void>((resolve, reject) => {
      (client.beta as any).sessions.events.stream(session.id)
        .then(async (stream: any) => {
          // Send message after stream opens
          await sendMsg;

          for await (const event of stream) {
            if (event.type === 'agent.message') {
              for (const block of event.content || []) {
                if (block.text) fullText.push(block.text);
              }
            } else if (event.type === 'agent.tool_use') {
              if (event.name === 'web_fetch') fetchCount++;
              // Log progress to agent_runs
              if (fetchCount % 10 === 0 && fetchCount > 0) {
                await pool.query(
                  `UPDATE agent_runs SET events_found = ? WHERE id = ?`,
                  [fetchCount, runId]
                );
              }
            } else if (event.type === 'session.status_idle') {
              resolve();
              break;
            } else if (event.type === 'session.error') {
              reject(new Error(`Session error: ${JSON.stringify(event)}`));
              break;
            }
          }
          resolve();
        })
        .catch(reject);
    });

    // Extract JSON from response
    const responseText = fullText.join('');
    const match = responseText.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Agent returned no JSON array — check agent instructions');

    const events: any[] = JSON.parse(match[0]);
    const inserted = await writeEvents(events, sourceId, runId, source.calendar_source_name);

    await pool.query(
      `UPDATE agent_runs SET status='completed', finished_at=NOW(),
       events_extracted=?, events_found=? WHERE id=?`,
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
          ev.eventType       || 'ot',
          ev.title,
          ev.description,
          ev.extendedDescription || null,
          JSON.stringify(ev.sponsors    || []),
          JSON.stringify(ev.postTypeId  || []),
          JSON.stringify(ev.sessions    || []),
          ev.locationType    || 'ne',
          ev.location        || null,
          ev.placeId         || null,
          ev.placeName       || null,
          ev.roomNum         || null,
          ev.urlLink         || null,
          ev.display         || 'all',
          JSON.stringify(ev.screensIds  || []),
          JSON.stringify(ev.buttons     || []),
          ev.contactEmail    || null,
          ev.phone           || null,
          ev.website         || null,
          ev.image_cdn_url   || null,
          ev.calendarSourceName || calendarSourceName,
          ev.calendarSourceUrl  || null,
          ev.geo_scope       || null,
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
