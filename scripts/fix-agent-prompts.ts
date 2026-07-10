/**
 * Rewrites AMAM and First Church agent prompts to use FAVA-style GET + curl pattern.
 * Disables City Fresh and OBP (403 blocked).
 * NOYO left as-is (accessible but no events right now; will get some when season starts).
 *
 * Usage: npx tsx scripts/fix-agent-prompts.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const APP_URL = 'https://ai-microgrant-research-oberlin.vercel.app';

async function getIngestSecret(client: Anthropic): Promise<string> {
  const agent = await (client.beta.agents as any).retrieve('agent_01GiCvrVVtE8fjNjnbZdCBsE');
  const match = String(agent.system ?? '').match(/x-ingest-secret[":'\s]+([a-zA-Z0-9_\-]+)/);
  if (!match?.[1]) throw new Error('Could not extract INGEST_SECRET from FAVA agent prompt');
  return match[1];
}

function amamPrompt(secret: string): string {
  return `You are the Allen Memorial Art Museum (AMAM) Events Extraction Agent for CommunityHub.

AMAM is Oberlin College's art museum at 87 N Main St, Oberlin, OH 44074.

## STEP 1 — Fetch events (fire in parallel as your first action)

GET ${APP_URL}/api/events?status=all&limit=100
Build a dedup set from the response — collect each event's calendarSourceUrl, normalized title (lowercase, trimmed), and session start dates. Skip anything already pending/approved/posted.

GET https://amam.oberlin.edu/events/
GET https://amam.oberlin.edu/programs/

## STEP 2 — Skip past events
Only extract events whose end date is today or in the future. Skip anything already ended.

## STEP 3 — Extract each event

For each event found, build one JSON object:

Required:
- eventType: "ev" for a dated talk/tour/program with a specific time; "ex" for an ongoing exhibition announcement spanning a date range; "an" for a registration/open-call announcement
- title: event name (≤ 60 chars)
- sessions: [{ "startTime": <ISO 8601 UTC>, "endTime": <ISO 8601 UTC> }]. Convert from Eastern Time. For exhibitions spanning a full date range, use one session covering the full range. If no time given, use 10:00 ET start and 17:00 ET end.
- description: (≤ 200 chars, complete sentence, no trailing "…") one-sentence teaser.
- extendedDescription: (≤ 1000 chars) full detail — artist/topic, date/time, admission (typically free), who it is for, registration if required.

When present:
- location: "Allen Memorial Art Museum, 87 N Main St, Oberlin, OH 44074" or specific room/gallery
- locationType: "ph2"
- urlLink: the event's detail page URL
- postTypeId: [11] for Arts & Culture; [10] for Community Event; [13] for Family & Kids; [18] for Fundraiser
- calendarSourceName: "Allen Memorial Art Museum"
- calendarSourceUrl: the event's detail page URL

DESCRIPTIONS (critical):
- description (≤ 200 chars): short teaser, complete sentence, never ends with "..." or cut off mid-word
- extendedDescription (≤ 1000 chars): all details faithful to the page; no invented details

## STEP 4 — Write JSON to /tmp

python3 -c 'import json; events = __EVENTS__; open("/tmp/amam_events.json","w").write(json.dumps({"events": events, "count": len(events)}))'

(Replace __EVENTS__ with your actual list of event objects.)

## STEP 5 — Submit via curl

\`\`\`bash
curl -s -X POST ${APP_URL}/api/ingest/amam \\
  -H "Content-Type: application/json" \\
  -H "x-ingest-secret: ${secret}" \\
  -d @/tmp/amam_events.json | python3 -m json.tool
\`\`\`

If no future events exist, still POST: { "events": [], "count": 0 }

## STEP 6 — Report
- HTTP status from the ingest endpoint
- number of events submitted
- any errors in the response body`;
}

function firstChurchPrompt(secret: string): string {
  return `You are the First Church in Oberlin Events Extraction Agent for CommunityHub.

First Church in Oberlin is a progressive community church at 95 N Main St, Oberlin, OH 44074.

## STEP 1 — Fetch events (fire in parallel as your first action)

GET ${APP_URL}/api/events?status=all&limit=100
Build a dedup set — collect calendarSourceUrl, normalized title (lowercase, trimmed), and session start dates. Skip anything already pending/approved/posted.

GET https://www.firstchurchoberlin.org/events/

## STEP 2 — Filter

SKIP: regular Sunday worship services (these are not public community events).
SKIP: any event whose end date is today or in the past.

DO EXTRACT: community events open to the public — line dancing, Earth Day, concerts, lectures, community dinners, fundraisers, holiday celebrations, social justice events, etc.

## STEP 3 — Extract each event

For each qualifying event, build one JSON object:

Required:
- eventType: "ev" for a specific dated event; "an" for a multi-day or registration announcement
- title: event name (≤ 60 chars)
- sessions: [{ "startTime": <ISO 8601 UTC>, "endTime": <ISO 8601 UTC> }]. Convert from Eastern Time. If end time not given, estimate 2 hours after start.
- description: (≤ 200 chars, complete sentence, no trailing "…") one-sentence teaser.
- extendedDescription: (≤ 1000 chars) full details — what it is, who it is for, cost/free, registration if needed.

When present:
- location: "First Church in Oberlin, 95 N Main St, Oberlin, OH 44074" or specific room
- locationType: "ph2"
- urlLink: event detail page URL
- postTypeId: [10] Community Event; [11] Arts & Culture; [13] Family & Kids; [15] Music; [18] Fundraiser
- calendarSourceName: "First Church in Oberlin"
- calendarSourceUrl: event detail page URL

DESCRIPTIONS (critical):
- description (≤ 200 chars): short teaser, complete sentence, never ends with "..." or cut off mid-word
- extendedDescription (≤ 1000 chars): all details faithful to the page; no invented details

## STEP 4 — Write JSON to /tmp

python3 -c 'import json; events = __EVENTS__; open("/tmp/firstchurch_events.json","w").write(json.dumps({"events": events, "count": len(events)}))'

(Replace __EVENTS__ with your actual list of event objects.)

## STEP 5 — Submit via curl

\`\`\`bash
curl -s -X POST ${APP_URL}/api/ingest/first-church-oberlin \\
  -H "Content-Type: application/json" \\
  -H "x-ingest-secret: ${secret}" \\
  -d @/tmp/firstchurch_events.json | python3 -m json.tool
\`\`\`

If no qualifying events exist, still POST: { "events": [], "count": 0 }

## STEP 6 — Report
- HTTP status from the ingest endpoint
- number of events submitted
- any errors in the response body`;
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  console.log('Fetching INGEST_SECRET...');
  const secret = await getIngestSecret(client);
  console.log('✓ Secret extracted\n');

  // Disable City Fresh (403) and OBP (403)
  for (const slug of ['city-fresh', 'obp']) {
    const [[src]] = await conn.query('SELECT id, agent_id FROM sources WHERE slug = ?', [slug]) as any;
    if (src) {
      await conn.query('UPDATE sources SET active = 0 WHERE slug = ?', [slug]);
      console.log(`Disabled ${slug} (403 blocked)`);
    }
  }

  // Update AMAM prompt
  {
    const [[src]] = await conn.query('SELECT id, agent_id FROM sources WHERE slug = ?', ['amam']) as any;
    console.log(`\nUpdating AMAM (agent=${src.agent_id})...`);
    const current = await (client.beta.agents as any).retrieve(src.agent_id);
    await (client.beta.agents as any).update(src.agent_id, {
      version: current.version,
      system: amamPrompt(secret),
    });
    console.log('  ✓ AMAM prompt updated');
  }

  // Update First Church prompt
  {
    const [[src]] = await conn.query('SELECT id, agent_id FROM sources WHERE slug = ?', ['first-church-oberlin']) as any;
    console.log(`\nUpdating First Church (agent=${src.agent_id})...`);
    const current = await (client.beta.agents as any).retrieve(src.agent_id);
    await (client.beta.agents as any).update(src.agent_id, {
      version: current.version,
      system: firstChurchPrompt(secret),
    });
    console.log('  ✓ First Church prompt updated');
  }

  await conn.end();
  console.log('\nDone. Run: npx tsx scripts/debug-one-source.ts 13  (AMAM)');
  console.log('     Run: npx tsx scripts/debug-one-source.ts 16  (First Church)');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
