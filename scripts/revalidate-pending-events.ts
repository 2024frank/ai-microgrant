/**
 * Recompute exact CommunityHub validation issues for pending drafts.
 * Dry-run by default; pass --apply to persist validation_errors.
 *
 * Usage:
 *   npx tsx scripts/revalidate-pending-events.ts
 *   npx tsx scripts/revalidate-pending-events.ts --apply
 */
import * as dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import {
  getCommunityHubExpirationIssue,
  validateCommunityHubPayload,
} from '../src/lib/communityHubPayload';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const APPLY = process.argv.includes('--apply');

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DATABASE_HOST,
    port: Number(process.env.DATABASE_PORT || 25060),
    user: process.env.DATABASE_USERNAME,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    ssl: { rejectUnauthorized: false },
  });

  try {
    const [rows] = await connection.query(
      `SELECT re.*
       FROM raw_events re
       WHERE re.status='pending'
       ORDER BY re.id`,
    ) as any;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const reports = (rows as any[]).map(row => {
      const rowPublishingEmail = (
        process.env.COMMUNITYHUB_EMAIL?.trim()
        || String(row.email || '').trim()
        || process.env.ADMIN_EMAIL?.trim()
        || ''
      );
      const result = validateCommunityHubPayload({ ...row, email: rowPublishingEmail });
      const normalized = result.success ? result.data : result.normalized;
      const expirationIssue = getCommunityHubExpirationIssue(normalized.sessions, nowSeconds);
      const errors = result.success ? [] : result.errors;
      return {
        id: Number(row.id),
        title: String(row.title),
        expired: Boolean(expirationIssue),
        errors,
      };
    });

    for (const report of reports) {
      const paths = [...new Set(report.errors.map(error => error.path))];
      console.log(`#${report.id} ${report.expired ? '[expired] ' : ''}${report.title}: ${paths.length ? paths.join(', ') : 'valid'}`);
    }
    console.log(`${reports.length} pending; ${reports.filter(report => report.errors.length).length} invalid; ${reports.filter(report => report.expired).length} expired.`);

    if (!APPLY) {
      console.log('Dry run only. Pass --apply to persist validation_errors.');
      return;
    }

    await connection.beginTransaction();
    try {
      for (const report of reports) {
        await connection.query(
          'UPDATE raw_events SET validation_errors=? WHERE id=? AND status=\'pending\'',
          [report.errors.length ? JSON.stringify(report.errors) : null, report.id],
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }
    console.log(`Persisted validation state for ${reports.length} pending draft(s).`);
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(`Pending-event revalidation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
});
