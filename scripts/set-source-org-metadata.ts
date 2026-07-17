/**
 * Backfill stable organization metadata onto sources (2026-07-16 meeting,
 * item 9) so the platform stamps it at ingestion instead of asking the agent
 * to rediscover it. Values below are only ones already verified in this
 * repository or production data; anything unverified stays NULL for an admin
 * to fill in via PATCH /api/sources/:id.
 *
 *   npx tsx scripts/set-source-org-metadata.ts          # dry run
 *   npx tsx scripts/set-source-org-metadata.ts --apply  # write changes
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });
import mysql from 'mysql2/promise';

type OrgMetadata = {
  match: string; // SQL LIKE pattern against slug or name
  org_sponsor_name: string;
  org_website: string | null;
  org_phone: string | null;
  org_contact_email: string | null;
  source_kind: 'original_org' | 'aggregator';
};

const ORGANIZATIONS: OrgMetadata[] = [
  {
    match: '%apollo%',
    org_sponsor_name: 'Apollo Theatre',
    // Verified: feed route calendarSourceUrl and scripts/patch-apollo-contacts.ts
    // values already live in production raw_events.
    org_website: 'https://www.clevelandcinemas.com/our-locations/x03gq-apollo-theatre/',
    org_phone: '440-774-3920',
    org_contact_email: 'apollo@clevelandcinemas.com',
    source_kind: 'original_org',
  },
  {
    match: '%common%ground%',
    org_sponsor_name: 'Common Ground Center',
    // Verified: the agent prompt in scripts/create-new-sources.ts extracts
    // from commongroundcenter.org.
    org_website: 'https://commongroundcenter.org',
    org_phone: null,
    org_contact_email: null,
    source_kind: 'original_org',
  },
  {
    match: '%library%',
    org_sponsor_name: 'Oberlin Public Library',
    org_website: null, // fill in after confirming the library's official site
    org_phone: null,
    org_contact_email: null,
    source_kind: 'original_org',
  },
  {
    match: '%heritage%',
    org_sponsor_name: 'Oberlin Heritage Center',
    org_website: null, // fill in after confirming the official site
    org_phone: null,
    org_contact_email: null,
    source_kind: 'original_org',
  },
];

async function main() {
  const apply = process.argv.includes('--apply');
  const conn = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT || '25060'),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
  });

  for (const org of ORGANIZATIONS) {
    const [rows] = await conn.query(
      `SELECT id, name, slug, source_kind, org_sponsor_name, org_website,
              org_phone, org_contact_email
       FROM sources WHERE slug LIKE ? OR name LIKE ?`,
      [org.match, org.match],
    ) as any;
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`(no source matches ${org.match})`);
      continue;
    }
    for (const row of rows) {
      console.log(`${row.slug} (#${row.id}) ← sponsor="${org.org_sponsor_name}" website=${org.org_website ?? 'NULL'} phone=${org.org_phone ?? 'NULL'} kind=${org.source_kind}`);
      if (!apply) continue;
      await conn.query(
        `UPDATE sources SET
           org_sponsor_name=?,
           org_website=COALESCE(?, org_website),
           org_phone=COALESCE(?, org_phone),
           org_contact_email=COALESCE(?, org_contact_email),
           source_kind=?
         WHERE id=?`,
        [
          org.org_sponsor_name,
          org.org_website,
          org.org_phone,
          org.org_contact_email,
          org.source_kind,
          row.id,
        ],
      );
    }
  }
  console.log(apply ? 'Applied.' : 'Dry run only; pass --apply to write.');
  await conn.end();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
