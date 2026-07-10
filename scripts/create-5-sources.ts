/**
 * Creates Anthropic agents + DB sources for:
 *   - Allen Memorial Art Museum (AMAM)
 *   - City Fresh
 *   - Northern Ohio Youth Orchestra (NOYO)
 *   - First Church in Oberlin
 *   - Oberlin Business Partnership (OBP)
 *
 * Usage: npx tsx scripts/create-5-sources.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

async function getIngestSecret(client: Anthropic): Promise<string> {
  const agent = await (client.beta.agents as any).retrieve('agent_01GiCvrVVtE8fjNjnbZdCBsE');
  const match = String(agent.system ?? '').match(/x-ingest-secret[":'\s]+([a-zA-Z0-9_\-]+)/);
  if (!match?.[1]) throw new Error('Could not extract INGEST_SECRET from FAVA agent prompt');
  return match[1];
}

// ── Allen Memorial Art Museum ────────────────────────────────────────────────
const AMAM_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the Allen Memorial Art Museum events page, extract ALL upcoming public events, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/amam
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://amam.oberlin.edu/events/
Read all upcoming events. Also check https://amam.oberlin.edu/programs/ if needed.

## STEP 2 — SKIP
Skip any event whose end date is today or in the past. Only extract future events.

## STEP 3 — EXTRACT each event

For each event found, produce one object with these fields:

**Required:**
- eventType — "ev" for a dated talk/tour/opening; "ex" for an ongoing exhibition with a date range; "an" for a registration-open announcement
- title — event name (≤ 60 chars)
- sessions — array of { startTime, endTime } in ISO 8601 UTC. Convert from Eastern Time (ET). For exhibitions spanning a date range, use one session covering the full range. If no specific time is given, use 10:00 AM ET as start and 5:00 PM ET as end.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence teaser.
- extendedDescription — (≤ 1000 chars): full details — artist/topic, date/time, admission (usually free), who it's for, registration if required.

**When present:**
- location — "Allen Memorial Art Museum, 87 N Main St, Oberlin, OH 44074" (or specific room)
- locationType — "ph2"
- urlLink — the event's detail page URL
- postTypeId — choose from: [11] Arts & Culture, [10] Community Event, [13] Family & Kids, [18] Fundraiser
- calendarSourceName — "Allen Memorial Art Museum"
- calendarSourceUrl — the event's detail page URL

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Must be a complete sentence ending with punctuation. NEVER end with "..." or be cut off mid-word.
- extendedDescription (≤ 1000 chars): All detail — artist, topic, gallery room, time, admission, registration link if needed.

## STEP 5 — SUBMIT
POST all extracted events:
{ "events": [...], "count": <number of events found before filtering> }

If no future events exist, still POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

// ── City Fresh ────────────────────────────────────────────────────────────────
const CF_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the City Fresh farm events page, extract ALL upcoming public events and farm distributions, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/city-fresh
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://cityfresh.org/farm-events/
Read all upcoming events. Also check https://cityfresh.org/events/ if it exists.

## STEP 2 — SKIP
Skip any event whose end date is today or in the past. Only extract future events.

## STEP 3 — EXTRACT each event

For each event found, produce one object:

**Required:**
- eventType — "ev" for a specific dated event or distribution
- title — event name (≤ 60 chars). For weekly Farm Friday distributions, use "Farm Friday — [Month Day]" if separate dates are listed, or "Farm Friday (Weekly)" if listed as recurring.
- sessions — array of { startTime, endTime } in ISO 8601 UTC. Convert from Eastern Time. Farm Fridays are typically 3:00–6:00 PM ET unless otherwise noted.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence description of the event.
- extendedDescription — (≤ 1000 chars): full details — what happens, location, cost/free, who can attend, CSA share pickup info if applicable.

**When present:**
- location — physical address of the distribution site (e.g. "Oberlin Farmers Market, downtown Oberlin, OH")
- locationType — "ph2"
- urlLink — event detail page URL if linked
- postTypeId — choose from: [10] Community Event, [13] Family & Kids, [18] Fundraiser
- calendarSourceName — "City Fresh"
- calendarSourceUrl — the URL you read

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Complete sentence. NEVER end with "..." or cut off.
- extendedDescription (≤ 1000 chars): Full details faithful to the page. No invented details.

## STEP 5 — SUBMIT
POST all upcoming events:
{ "events": [...], "count": <total events on page before filtering> }

If none, POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

// ── Northern Ohio Youth Orchestra (NOYO) ─────────────────────────────────────
const NOYO_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the NOYO (Northern Ohio Youth Orchestra) calendar/events page, extract ALL upcoming concerts and public events, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/noyo
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://www.noyo.org/tickets-events
Also try https://www.noyo.org/calendar if needed.
Read all upcoming concerts and events.

## STEP 2 — SKIP
Skip any event whose end date is today or in the past. Only extract future events.

## STEP 3 — EXTRACT each event

For each concert/event found, produce one object:

**Required:**
- eventType — "ev" for a specific concert or event date
- title — concert name (≤ 60 chars), e.g. "NOYO Spring Concert" or "NOYO Summer Symphony"
- sessions — [{ startTime, endTime }] in ISO 8601 UTC. Convert from Eastern Time. Typical concert duration is 2 hours; if end time not given, add 2 hours to start.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence teaser about the concert.
- extendedDescription — (≤ 1000 chars): program details, featured soloists, conductor, venue, ticket price, how to buy tickets, who the orchestra is.

**Always include:**
- location — venue name and address (typically Finney Chapel, 187 N Professor St, Oberlin, OH 44074 or similar)
- locationType — "ph2"
- postTypeId — [15] Music, or [11] Arts & Culture if not a concert
- calendarSourceName — "Northern Ohio Youth Orchestra"
- calendarSourceUrl — the URL of the event detail page, or "https://www.noyo.org/tickets-events"
- urlLink — ticket purchase page if listed

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Complete sentence. NEVER end with "..." or cut off.
- extendedDescription (≤ 1000 chars): Full program and logistics. Faithful to page; no invented details.

## STEP 5 — SUBMIT
POST all upcoming events:
{ "events": [...], "count": <total events before filtering> }

If none, POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

// ── First Church in Oberlin ───────────────────────────────────────────────────
const FC_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the First Church in Oberlin events page, extract ALL upcoming public community events (not private worship services), and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/first-church-oberlin
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://www.firstchurchoberlin.org/events/
Read all upcoming events listed.

## STEP 2 — FILTER & SKIP
- Skip regular Sunday worship services — they are not public community events.
- Skip any event whose end date is today or in the past.
- DO extract: community events open to all (line dancing, Earth Day, concerts, lectures, community dinners, social justice events, fundraisers, holiday celebrations, etc.)

## STEP 3 — EXTRACT each event

**Required:**
- eventType — "ev" for a specific dated event; "an" for a registration/announcement with a date range
- title — event name (≤ 60 chars)
- sessions — [{ startTime, endTime }] in ISO 8601 UTC. Convert from Eastern Time. If end time not given, estimate 2 hours.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence teaser.
- extendedDescription — (≤ 1000 chars): full details — what it is, who it's for, cost/free, registration if needed.

**When present:**
- location — "First Church in Oberlin, 95 N Main St, Oberlin, OH 44074" or specific room
- locationType — "ph2"
- urlLink — event detail page URL
- postTypeId — [10] Community Event, [11] Arts & Culture, [13] Family & Kids, [15] Music, [18] Fundraiser
- calendarSourceName — "First Church in Oberlin"
- calendarSourceUrl — event detail page URL

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Complete sentence. NEVER end with "..." or cut off.
- extendedDescription (≤ 1000 chars): All details faithful to page. No invented details.

## STEP 5 — SUBMIT
POST all qualifying upcoming events:
{ "events": [...], "count": <total events considered before filtering> }

If none qualify, POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

// ── Oberlin Business Partnership (OBP) ───────────────────────────────────────
const OBP_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the Oberlin Business Partnership community calendar, extract ALL upcoming public events, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/obp
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://www.oberlinbusinesspartnership.com/calendar/
Read all upcoming events. Click through to individual event pages for full details.

## STEP 2 — SKIP
Skip any event whose end date is today or in the past. Only extract future events.

## STEP 3 — EXTRACT each event

For each event found, produce one object:

**Required:**
- eventType — "ev" for a specific dated event; "an" for a multi-day festival or open registration
- title — event name (≤ 60 chars)
- sessions — [{ startTime, endTime }] in ISO 8601 UTC. Convert from Eastern Time. For multi-day events use one session spanning the full range.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence teaser.
- extendedDescription — (≤ 1000 chars): full details — what it is, location, cost, who organizes it, what to bring/expect.

**When present:**
- location — physical address or "Downtown Oberlin, OH"
- locationType — "ph2"
- urlLink — event detail page URL
- postTypeId — [10] Community Event, [11] Arts & Culture, [13] Family & Kids, [15] Music, [18] Fundraiser
- calendarSourceName — "Oberlin Business Partnership"
- calendarSourceUrl — event detail page URL

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Complete sentence. NEVER end with "..." or cut off.
- extendedDescription (≤ 1000 chars): All details faithful to page. No invented details.

## STEP 5 — SUBMIT
POST all upcoming events:
{ "events": [...], "count": <total events before filtering> }

If none, POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST, port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME, password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME, ssl: { rejectUnauthorized: false },
  });

  console.log('Fetching INGEST_SECRET from live agent...');
  const INGEST_SECRET = await getIngestSecret(client);
  console.log('✓ Secret extracted\n');

  const sources = [
    {
      name: 'Allen Memorial Art Museum',
      slug: 'amam',
      calendarSourceName: 'Allen Memorial Art Museum',
      schedule: '0 8 * * 1',   // Weekly Mondays
      system: AMAM_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET),
    },
    {
      name: 'City Fresh',
      slug: 'city-fresh',
      calendarSourceName: 'City Fresh',
      schedule: '0 8 * * 1',   // Weekly Mondays
      system: CF_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET),
    },
    {
      name: 'Northern Ohio Youth Orchestra',
      slug: 'noyo',
      calendarSourceName: 'Northern Ohio Youth Orchestra',
      schedule: '0 8 1 * *',   // Monthly
      system: NOYO_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET),
    },
    {
      name: 'First Church in Oberlin',
      slug: 'first-church-oberlin',
      calendarSourceName: 'First Church in Oberlin',
      schedule: '0 8 * * 1',   // Weekly Mondays
      system: FC_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET),
    },
    {
      name: 'Oberlin Business Partnership',
      slug: 'obp',
      calendarSourceName: 'Oberlin Business Partnership',
      schedule: '0 8 * * 1',   // Weekly Mondays
      system: OBP_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET),
    },
  ];

  const created: { id: number; name: string; agent_id: string; slug: string }[] = [];

  for (const src of sources) {
    const [[existing]] = await conn.query(
      'SELECT id, agent_id FROM sources WHERE slug = ?', [src.slug]
    ) as any;

    if (existing) {
      console.log(`${src.name}: already exists (id=${existing.id}), skipping.`);
      created.push({ id: existing.id, name: src.name, agent_id: existing.agent_id, slug: src.slug });
      continue;
    }

    console.log(`Creating agent for ${src.name}...`);
    const agent = await (client.beta.agents as any).create({
      name:   src.name,
      model:  'claude-sonnet-4-6',
      system: src.system,
      tools:  [{ type: 'agent_toolset_20260401', configs: [], default_config: { enabled: true, permission_policy: { type: 'always_allow' } } }],
    });
    console.log(`  ✓ agent_id = ${agent.id}`);

    const [res] = await conn.query(`
      INSERT INTO sources (name, slug, agent_id, source_type, calendar_source_name, schedule_cron, active)
      VALUES (?, ?, ?, 'web', ?, ?, 1)
    `, [src.name, src.slug, agent.id, src.calendarSourceName, src.schedule]) as any;

    console.log(`  ✓ DB source id = ${res.insertId}, schedule = ${src.schedule}`);
    created.push({ id: res.insertId, name: src.name, agent_id: agent.id, slug: src.slug });
  }

  await conn.end();

  console.log('\n✓ All sources ready:');
  for (const s of created) {
    console.log(`  id=${s.id}  slug=${s.slug}  agent=${s.agent_id}`);
  }
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
