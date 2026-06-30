/** Is the Apollo feed endpoint deployed? Prints status + the live announcements.
 *  npx tsx scripts/check-feed.ts */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

(async () => {
  const url = (process.env.APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app') + '/api/sources/apollo/feed';
  console.log('GET', url);
  try {
    const res = await fetch(url, { headers: { 'x-ingest-secret': process.env.INGEST_SECRET || '' } });
    console.log('HTTP', res.status);
    const j: any = await res.json().catch(() => null);
    if (j?.events) {
      console.log(`events: ${j.events.length}`);
      for (const e of j.events) console.log(`   ${e.title} :: ${e.description}`);
    } else {
      console.log('body:', JSON.stringify(j).slice(0, 300));
    }
  } catch (e: any) {
    console.log('fetch error:', e.message);
  }
})();
