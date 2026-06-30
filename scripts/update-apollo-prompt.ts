/**
 * Updates the Apollo Theatre agent system prompt on the Anthropic API.
 *
 * The agent NO LONGER scrapes Veezi or computes dates — extraction + segmentation
 * happen deterministically in GET /api/sources/apollo/feed (see
 * src/app/api/sources/apollo/feed/route.ts and src/lib/sources/apolloSegments.ts).
 * The agent only fetches the ready-made announcements, adds a poster per movie,
 * and posts. Run this AFTER the feed endpoint is deployed.
 *
 * Usage: npx tsx scripts/update-apollo-prompt.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import Anthropic from '@anthropic-ai/sdk';

const AGENT_ID = process.env.APOLLO_AGENT_ID || 'agent_011JUMEmkFKkyJRckbWongao';
const INGEST_SECRET = process.env.INGEST_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

function buildPrompt(appUrl: string, ingestSecret: string): string { return `You are the Apollo Theatre Agent for CommunityHub.

The Veezi schedule is extracted and segmented for you DETERMINISTICALLY on the server. You do NOT scrape Veezi, read any HTML, or compute any dates — that work is already done and is correct. Your only jobs are: fetch the ready-made announcements, find one poster per movie, and post.

## STEP 1 — Fetch the ready-made announcements
GET ${appUrl}/api/sources/apollo/feed
Header: x-ingest-secret: ${ingestSecret}

The response is:
{ "events": [ ...complete announcement payloads... ] }

Each event is a finished CommunityHub payload (title, description, sessions with Unix start/end, extendedDescription, buttons, etc.) plus two helper fields:
- "movies": the films in that announcement, each { title, rating }
- "poster_urls": an empty array for you to fill

DO NOT modify title, description, sessions, or any other field — they are correct. The description wording ("— now playing", "— through <date>", "— opens <date>") is intentional; never change it to a date range.

If "events" is empty, post nothing and report that the schedule was empty.

## STEP 2 — Find one poster per movie (run all searches in parallel)
Collect the unique movie titles across every event's "movies" list. For each title:
1. web_search: "<movie title>" official movie poster site:themoviedb.org OR site:imdb.com
2. Pick a direct, high-resolution image URL — prefer https://image.tmdb.org/t/p/original/... or https://m.media-amazon.com/images/M/....jpg
3. If you only get a page URL, web_fetch it and take the og:image value.
Keep a map { movieTitle -> posterUrl }. A title's posterUrl is null only if every attempt fails.

## STEP 3 — Attach posters
For each event, set "poster_urls" to the posters for that event's "movies", in the same order, skipping any nulls. If no posters were found for an event, leave "poster_urls" as an empty array. Leave the "movies" field untouched.

## STEP 4 — POST everything to the ingest endpoint
POST ${appUrl}/api/ingest/apollo-theater
Headers: x-ingest-secret: ${ingestSecret} , Content-Type: application/json
Body: { "events": [ ...all events from step 1, now with poster_urls... ] }

## STEP 5 — Report
- the HTTP status from the ingest endpoint
- how many "Apollo - Showing Now" and "Apollo - Coming Soon" announcements you submitted
- any error message in the response body

Never invent movies, dates, or showtimes. The feed is the single source of truth.`;
}

async function main() {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  console.log('Fetching current agent...');
  const current = await (client.beta.agents as any).retrieve(AGENT_ID);

  // Preserve the ingest secret that already works against production — the live
  // prompt embeds it; the local .env may be stale (it was, here).
  const existingSecret = (String(current.system ?? '').match(/x-ingest-secret:\s*([^\s]+)/) || [])[1];
  const ingestSecret = existingSecret || INGEST_SECRET;
  if (!ingestSecret) { console.error('No ingest secret found (live prompt or INGEST_SECRET env)'); process.exit(1); }

  const prompt = buildPrompt(APP_URL, ingestSecret);

  console.log(`Current version: ${current.version}  model: ${typeof current.model === 'string' ? current.model : current.model?.id}  secret: ${existingSecret ? 'preserved from live prompt' : 'from env'}`);
  console.log('Updating system prompt → feed-based (no Veezi scraping)...');

  const updated = await (client.beta.agents as any).update(AGENT_ID, {
    system: prompt,
    version: current.version,
  });

  console.log(`✓ Updated to version: ${updated.version}`);
  console.log(`  Name: ${updated.name}`);
  console.log(`  Updated at: ${updated.updated_at}`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
