/**
 * Debug: compare what the Apollo agent stored vs. the live Veezi ground truth.
 *   npx tsx scripts/apollo-debug.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import mysql from 'mysql2/promise';
import { parseVeeziSessions, dedupeFilms } from '../src/lib/sources/veezi';

async function main() {
  const conn = await mysql.createConnection({
    host:     process.env.DATABASE_HOST,
    port:     parseInt(process.env.DATABASE_PORT || '25060'),
    user:     process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl:      { rejectUnauthorized: false },
  });

  const [rows] = await conn.query(
    `SELECT id, title, event_type, status, LEFT(description,400) AS description,
            LEFT(sessions,200) AS sessions, created_at
     FROM raw_events WHERE source_id = 3 ORDER BY id DESC LIMIT 25`
  ) as any;
  await conn.end();

  console.log(`=== Apollo raw_events (source #3) — latest ${(rows as any[]).length} ===\n`);
  for (const r of rows as any[]) {
    console.log(`#${r.id} [${r.status}] type=${r.event_type}  "${r.title}"   ${r.created_at}`);
    console.log(`   desc: ${r.description}`);
    console.log(`   sessions(raw): ${r.sessions}`);
    // decode the session unix windows to human dates
    try {
      const ss = JSON.parse((r.sessions || '').replace(/\.\.\.$/, '') || '[]');
      for (const s of ss) {
        const f = (t: any) => (t ? new Date(Number(t) * 1000).toISOString().slice(0, 16) : '?');
        console.log(`     window: ${f(s.startTime)}  ->  ${f(s.endTime)}`);
      }
    } catch {}
    console.log();
  }

  // Live ground truth — pull the siteToken from the live agent prompt (don't print it)
  let token = process.env.APOLLO_VEEZI_SITE_TOKEN;
  if (!token) {
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default;
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const agent = await (client.beta.agents as any).retrieve('agent_011JUMEmkFKkyJRckbWongao');
      const sys = agent.system ?? agent.system_prompt ?? '';
      token = sys.match(/siteToken=([A-Za-z0-9_-]+)/)?.[1];
    } catch (e: any) { console.log('could not read token from agent:', e.message); }
  }
  if (!token) { console.log('No Veezi siteToken — skipping live fetch'); return; }
  const url = `https://ticketing.uswest.veezi.com/sessions/?siteToken=${token}`;
  console.log(`=== LIVE Veezi ground truth (${url.replace(token, '…')}) ===\n`);
  const res = await fetch(url);
  console.log(`HTTP ${res.status}, ${(await res.clone().text()).length} bytes`);
  const html = await res.text();
  const films = dedupeFilms(parseVeeziSessions(html));
  console.log(`Parsed ${films.length} unique films:\n`);
  for (const f of films) {
    const dates = [...new Set(f.showtimes.map(s => s.date))];
    console.log(`  "${f.title}"  rating=${f.rating ?? '—'}  (${f.showtimes.length} showtimes)`);
    console.log(`     dates: ${dates.join(' | ')}`);
  }
}

main().catch(e => { console.error('apollo-debug failed:', e.message); process.exit(1); });
