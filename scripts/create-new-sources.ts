/**
 * Creates Anthropic agents + DB sources for:
 *   - Common Ground Center (Oberlin OH) — outdoor/experiential programs
 *   - Riverdog Music (near Oberlin OH) — Americana house concerts
 *
 * Usage: npx tsx scripts/create-new-sources.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

// Extracted from the live FAVA agent prompt (not stored in local .env)
async function getIngestSecret(client: Anthropic): Promise<string> {
  const agent = await (client.beta.agents as any).retrieve('agent_01GiCvrVVtE8fjNjnbZdCBsE');
  const match = String(agent.system ?? '').match(/x-ingest-secret[":'\s]+([a-zA-Z0-9_\-]+)/);
  if (!match?.[1]) throw new Error('Could not extract INGEST_SECRET from FAVA agent prompt');
  return match[1];
}

// ── Common Ground Center ──────────────────────────────────────────────────────
const CG_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the Common Ground Center website, extract ALL upcoming public events, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/common-ground
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://commongroundcenter.org/upcoming-events/
Read the full page. Also check https://commongroundcenter.org/events/ if needed.

## STEP 2 — SKIP
Skip any event whose end date is today or in the past. Only extract future events.

## STEP 3 — EXTRACT each event

For each event found, produce one object with these fields:

**Required:**
- eventType — "ev" for a single-day event with a specific date/time; "an" for a multi-day program, retreat, or open registration period
- title — the event or program name (≤ 60 chars)
- sessions — array of { startTime, endTime } as Unix timestamps in SECONDS (integer). Convert from Eastern Time (ET). Example: Sep 19 2026 6:30 PM ET = 1758313800. For an announcement spanning a date range, use one session covering the full range (start 00:00 ET, end 23:59 ET). If no specific time is given, use 09:00 ET as start.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one-sentence teaser of what the event is.
- extendedDescription — (≤ 1000 chars): full details — date/time, location on site, cost/registration, who it's for, what happens. Faithful to the page; no invented details.

**When present on the page:**
- location — physical location/address: "Common Ground Center, 14240 Baird Rd, Oberlin, OH 44074" (or specific area on site)
- locationType — "ph2" (physical)
- urlLink — the event's detail page URL if linked
- postTypeId — choose: [10] Community Event, [11] Arts & Culture, [12] Sports & Recreation, [13] Family & Kids, [18] Fundraiser
- calendarSourceName — "Common Ground Center"
- calendarSourceUrl — the URL of the event's detail page

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser. Must be a complete sentence ending with punctuation. NEVER end with "..." or be cut off mid-word.
- extendedDescription (≤ 1000 chars): All the detail — location on site, what participants do, age/prerequisite, cost, registration link, what to bring.

## STEP 5 — SUBMIT
POST all extracted events to the ingest endpoint as a single request:
{ "events": [...], "count": <number of events found before filtering> }

If no future events exist, still POST: { "events": [], "count": 0 }

Return only the JSON you submitted.`;

// ── Riverdog Music ────────────────────────────────────────────────────────────
const RD_SYSTEM = `You are an event extraction agent for the AI Events Ingestion Software at CommunityHub (Oberlin, Ohio).

Your job: visit the Riverdog Music shows page, extract ALL upcoming concerts, and submit them to the ingest endpoint.

## INGEST ENDPOINT
POST ${APP_URL}/api/ingest/riverdog
Headers: { "Content-Type": "application/json", "x-ingest-secret": "__INGEST_SECRET__" }
Body: { "events": [ ...array of event objects... ] }

## STEP 1 — BROWSE
Visit: https://riverdogmusic.weebly.com/shows.html
Read the full page. Events are separated by *** dividers and listed chronologically.

## STEP 2 — SKIP
Skip any show whose date is today or in the past. The season runs July–October.

## STEP 3 — EXTRACT each show

Each show block contains: date, time, donation amount, artist name(s), description/bio, and sometimes a "More info" or "Reserve seats" link.

For each upcoming show, produce one object:

**Required:**
- eventType — "ev" (each show is a single dated event)
- title — artist name(s), e.g. "The Rough & Tumble" or "Naomi Schag + Townline 26" (≤ 60 chars)
- sessions — [{ startTime, endTime }] as Unix timestamps in SECONDS (integer). Convert from Eastern Time. Example: Jul 11 2026 7:30 PM ET = 1752283800. Shows start at 7:30 PM ET; set endTime to 10:00 PM ET unless stated otherwise.
- description — (≤ 200 chars, complete sentence, no trailing "…"): one sentence about the artist/show. E.g., "Americana duo The Rough & Tumble performs at Riverdog, a historic barn concert venue near Oberlin."
- extendedDescription — (≤ 1000 chars): artist bio, genre, what to expect, ticket/donation info ($22 donation, cash preferred), venue details, any age info or parking notes from the page.

**Always include:**
- location — "Riverdog, Henrietta Township, OH (near Oberlin)"
- locationType — "ph2"
- postTypeId — [15] (Music)
- calendarSourceName — "Riverdog Music"
- calendarSourceUrl — "https://riverdogmusic.weebly.com/shows.html"
- urlLink — the "More info" or "Reserve seats" link if present, otherwise "https://riverdogmusic.weebly.com/shows.html"

## STEP 4 — DESCRIPTIONS (critical)
- description (≤ 200 chars): Short teaser about the artist. Complete sentence. NEVER end with "..." or cut off mid-word.
- extendedDescription (≤ 1000 chars): Full artist bio from the page + show details (date, time, $22 donation, barn venue near Oberlin, cash preferred). Faithful to the page; no invented details.

## STEP 5 — SUBMIT
POST all upcoming shows to the ingest endpoint:
{ "events": [...], "count": <total shows on page before filtering> }

If no future shows are listed, still POST: { "events": [], "count": 0 }

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

  // Replace placeholder in prompts now that we have the secret
  const cgSystem = CG_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET);
  const rdSystem = RD_SYSTEM.replace('__INGEST_SECRET__', INGEST_SECRET);

  const sources = [
    {
      name: 'Common Ground Center',
      slug: 'common-ground',
      calendarSourceName: 'Common Ground Center',
      schedule: '0 8 1 * *', // Monthly on the 1st at 8am
      system: cgSystem,
    },
    {
      name: 'Riverdog Music',
      slug: 'riverdog',
      calendarSourceName: 'Riverdog Music',
      schedule: '0 8 * * 1', // Weekly on Mondays at 8am
      system: rdSystem,
    },
  ];

  for (const src of sources) {
    // Check if already exists in DB
    const [[existing]] = await conn.query(
      'SELECT id, agent_id FROM sources WHERE slug = ?', [src.slug]
    ) as any;

    if (existing) {
      console.log(`${src.name}: already exists (id=${existing.id}), skipping.`);
      continue;
    }

    // Create Anthropic agent
    console.log(`Creating agent for ${src.name}...`);
    const agent = await (client.beta.agents as any).create({
      name:   src.name,
      model:  'claude-sonnet-4-6',
      system: src.system,
      tools:  [{ type: 'agent_toolset_20260401', configs: [], default_config: { enabled: true, permission_policy: { type: 'always_allow' } } }],
    });
    console.log(`  ✓ agent_id = ${agent.id}`);

    // Register source in DB
    const [res] = await conn.query(`
      INSERT INTO sources (name, slug, agent_id, source_type, calendar_source_name, schedule_cron, active)
      VALUES (?, ?, ?, 'web', ?, ?, 1)
    `, [src.name, src.slug, agent.id, src.calendarSourceName, src.schedule]) as any;

    console.log(`  ✓ DB source id = ${res.insertId}, schedule = ${src.schedule}`);
  }

  await conn.end();
  console.log('\nDone. Run the agents from the Sources page to test them.');
}

main().catch(e => { console.error('Failed:', e.message); process.exit(1); });
