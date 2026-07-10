/**
 * Batch image finder for pending events that have no image.
 *
 * Usage:
 *   npx tsx scripts/add-images-to-events.ts --test      # 1 event per source, no DB writes
 *   npx tsx scripts/add-images-to-events.ts --dry-run   # all events, no DB writes
 *   npx tsx scripts/add-images-to-events.ts             # all events, update DB
 *
 * Processes sequentially (one session at a time) for reliability.
 * Deduplicates: AMAM and NOYO each make only 1 agent call, result reused for all.
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import Anthropic from '@anthropic-ai/sdk';
import mysql from 'mysql2/promise';

const IS_TEST  = process.argv.includes('--test');
const IS_DRY   = IS_TEST || process.argv.includes('--dry-run');
const POLL_MAX = 100; // 100 × 3 s = 5 min max per session

// ---------------------------------------------------------------------------
// System prompt for image-finder agent
// ---------------------------------------------------------------------------
const SYSTEM = `You search the web for image URLs.
Given an artist or event description, find ONE direct image URL (.jpg .jpeg .png .webp .gif).

Rules:
1. Return ONLY the raw URL on a single line — no markdown, no quotes, no explanation.
2. Prefer official artist websites, press kits, Last.fm artist images, or AllMusic photos.
3. For venues/organizations: prefer their official website's own hosted images.
4. If you cannot find a relevant real image URL, return exactly: NONE`;

// ---------------------------------------------------------------------------
// Cache key: same search type → same image URL (avoids duplicate sessions)
// ---------------------------------------------------------------------------
function cacheKey(e: { source_name: string; title: string }): string {
  if (e.source_name === 'Allen Memorial Art Museum') return '__amam__';
  if (e.source_name === 'Northern Ohio Youth Orchestra') return '__noyo__';
  if (e.source_name === 'Common Ground Center') return '__cg__';
  if (e.source_name === 'First Church in Oberlin')
    return e.title.includes('Crusher') ? '__fc_crushers__' : '__fc_memorial__';
  // Riverdog: split on " and " or " with " (NOT bare & — that's part of duo names like "Warren & Flick")
  const primary = e.title.split(/\s+(?:\band\b|\bwith\b)\s+/i)[0].trim();
  return `rd:${primary.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Per-event search prompts
// ---------------------------------------------------------------------------
function buildPrompt(e: { source_name: string; title: string }): string {
  switch (e.source_name) {

    case 'Riverdog Music': {
      // For multi-act bills like "The Rough & Tumble and Flagship Romance",
      // search for the primary headliner only. Split on " and " or " with " but NOT bare &.
      const primary = e.title.split(/\s+(?:\band\b|\bwith\b)\s+/i)[0].trim();
      return `Find a promotional press photo or headshot for the musical artist or band: "${primary}".
Try searching "${primary} music press photo" and "${primary} official website".
Prefer the artist's own website, a music press kit page, or Last.fm artist image.
Return ONLY a direct image URL ending in .jpg, .png, or .webp — or NONE if nothing found.`;
    }

    case 'Allen Memorial Art Museum':
      return `Find a photo of Frank Lloyd Wright's Weltzheimer/Johnson House in Oberlin Ohio (a Usonian home on the Oberlin College campus, open to public tours).
Search: "Weltzheimer Johnson House Oberlin Ohio Frank Lloyd Wright exterior".
Also try: "Allen Memorial Art Museum Oberlin Ohio building exterior photo".
Return ONLY a direct image URL (.jpg or .png) — or NONE.`;

    case 'Northern Ohio Youth Orchestra':
      return `Find a photo for the Northern Ohio Youth Orchestra (NOYO) based in Oberlin Ohio, a youth string orchestra.
Search: "Northern Ohio Youth Orchestra NOYO Oberlin Ohio".
Prefer a photo from their official website noyo.org.
Return ONLY a direct image URL (.jpg or .png) — or NONE.`;

    case 'First Church in Oberlin':
      if (e.title.includes('Crusher')) {
        return `Find a photo for the Lake Erie Crushers minor league baseball team located in Avon Ohio near Cleveland.
Search: "Lake Erie Crushers baseball team photo" or "Lake Erie Crushers stadium".
Return ONLY a direct image URL (.jpg or .png) — or NONE.`;
      }
      return `Find a photo of First Church in Oberlin Ohio, a historic United Church of Christ congregation on the Oberlin town square.
Search: "First Church Oberlin Ohio" or "First Congregational Church Oberlin building exterior".
Return ONLY a direct image URL (.jpg or .png) — or NONE.`;

    default: // Common Ground Center — firewalk
      return `Find a photo for a firewalk ceremony or workshop, or for the event "Gregg Gilder Memorial Firewalk" in Ohio.
Search: "Gregg Gilder firewalk" or "firewalk ceremony workshop fire walking".
Also try: "Common Ground Center Oberlin Ohio event".
Return ONLY a direct image URL (.jpg or .png) — or NONE.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function extractUrl(text: string): string | null {
  if (!text || /^NONE$/i.test(text.trim())) return null;
  // Match direct image URL
  const m = text.match(/https?:\/\/[^\s"'<>]+\.(jpg|jpeg|png|webp|gif)/i);
  if (!m) return null;
  return m[0].replace(/[,;."')\]>]+$/, ''); // strip trailing punctuation
}

async function runSession(
  client: Anthropic,
  agentId: string,
  envId: string,
  prompt: string,
): Promise<string | null> {
  const sess = await (client.beta.sessions as any).create({
    agent: agentId,
    environment_id: envId,
  });

  await (client.beta.sessions as any).events.send(sess.id, {
    events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
  });

  let done = false;
  let afterCreatedAt: string | undefined;
  for (let i = 0; i < POLL_MAX && !done; i++) {
    await sleep(3000);
    const page = await (client.beta.sessions as any).events.list(sess.id, {
      ...(afterCreatedAt ? { 'created_at[gt]': afterCreatedAt } : {}),
      limit: 100,
      order: 'asc',
    }) as any;
    for (const evt of (page.data ?? [])) {
      if (evt.created_at) afterCreatedAt = evt.created_at;
      if (evt.type === 'session.status_idle') { done = true; break; }
    }
  }

  if (!done) return null; // session timed out

  // Collect all events to find the last agent.message text
  const allEvts = await (client.beta.sessions as any).events.list(sess.id, {
    limit: 200,
    order: 'asc',
  }) as any;

  let lastText = '';
  for (const evt of (allEvts.data ?? [])) {
    if (evt.type === 'agent.message') {
      for (const blk of (evt.content || [])) {
        if (blk.type === 'text') lastText = (blk as any).text.trim();
      }
    }
  }
  return extractUrl(lastText);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
    connectTimeout: 10000,
  });

  const envId = process.env.SOURCE_BUILDER_ENVIRONMENT_ID ?? '';
  if (!envId) throw new Error('SOURCE_BUILDER_ENVIRONMENT_ID not set in .env');

  // Fetch all pending events without images
  const [rows] = await conn.query(`
    SELECT re.id, re.title, re.url_link, s.name AS source_name
    FROM raw_events re
    JOIN sources s ON s.id = re.source_id
    WHERE re.source_id IN (11,12,13,15,16)
      AND re.status = 'pending'
      AND re.image_cdn_url IS NULL
      AND re.image_data IS NULL
    ORDER BY re.source_id, re.id
  `) as any;

  // In test mode: one event per source
  let toProcess: any[] = rows;
  if (IS_TEST) {
    const seen = new Set<string>();
    toProcess = [];
    for (const e of rows) {
      if (!seen.has(e.source_name)) { seen.add(e.source_name); toProcess.push(e); }
    }
    console.log(`TEST MODE — ${toProcess.length} events (one per source), no DB writes\n`);
  } else {
    console.log(`${IS_DRY ? 'DRY RUN' : 'LIVE'} — ${toProcess.length} events, sequential processing\n`);
  }

  // Create temporary image-finder agent
  process.stdout.write('Creating image-finder agent... ');
  const agent = await (client.beta.agents as any).create({
    name: 'Image Finder (temp)',
    model: 'claude-sonnet-4-6',
    system: SYSTEM,
    tools: [{
      type: 'agent_toolset_20260401',
      configs: [],
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    }],
  });
  process.stdout.write(`${agent.id}\n\n`);

  const cache: Record<string, string | null> = {};
  let found = 0, missing = 0, fromCache = 0;

  for (const e of toProcess) {
    const k = cacheKey(e);
    let url: string | null;

    if (k in cache) {
      url = cache[k];
      fromCache++;
      const label = e.source_name === 'Riverdog Music'
        ? e.title.split(/\s+(?:\band\b|\bwith\b)\s+/i)[0].trim()
        : e.source_name;
      process.stdout.write(`#${e.id} "${e.title.slice(0,50)}"  [cached from ${label}]\n`);
      process.stdout.write(`       → ${url ?? 'NONE'}\n`);
    } else {
      process.stdout.write(`#${e.id} "${e.title.slice(0,50)}"  searching...\n`);
      url = await runSession(client, agent.id, envId, buildPrompt(e));
      cache[k] = url;
      process.stdout.write(`       → ${url ?? 'NONE'}\n`);
    }

    if (url) {
      found++;
      if (!IS_DRY) {
        await conn.query('UPDATE raw_events SET image_cdn_url = ? WHERE id = ?', [url, e.id]);
        process.stdout.write(`       ✓ DB updated\n`);
      }
    } else {
      missing++;
    }
  }

  // Remove temp agent
  try { await (client.beta.agents as any).delete(agent.id); } catch {}

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`Processed: ${toProcess.length}  |  Found: ${found}  |  Missing: ${missing}  |  Cache hits: ${fromCache}`);
  if (IS_DRY) console.log('DRY RUN — no DB changes made.');
  else console.log('DB updated ✓');

  await conn.end();
  process.exit(0);
}

main().catch(e => { console.error(e.message); process.exit(1); });
