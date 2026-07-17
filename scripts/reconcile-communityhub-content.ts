/**
 * Reconcile local `submitted` rows against CommunityHub's complete approved
 * and pending future inventory using event content, never IDs.
 *
 * Dry run (default):
 *   npx tsx scripts/reconcile-communityhub-content.ts
 *
 * Apply only after reviewing the dry-run output:
 *   npx tsx scripts/reconcile-communityhub-content.ts --apply
 */
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const APPLY = process.argv.includes('--apply');

async function main() {
  const required = [
    'DATABASE_HOST',
    'DATABASE_NAME',
    'DATABASE_USERNAME',
    'DATABASE_PASSWORD',
  ];
  const missing = required.filter(key => !process.env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`database environment is incomplete: ${missing.join(', ')}`);
  }

  // Import only after dotenv has run; the shared database pool reads its
  // configuration during module initialization.
  const { reconcileCommunityHubContent } = await import(
    '../src/lib/communityHubContentReconciliation'
  );
  const result = await reconcileCommunityHubContent({ apply: APPLY });
  console.log(
    `CommunityHub inventory: ${result.inventory.approved} approved, ${result.inventory.pending} pending, ${result.inventory.pages} page(s), digest ${result.inventory.sha256.slice(0, 12)}`,
  );
  console.log(
    `Eligible waiting rows: ${result.eligible_waiting_rows}; exact content matches: ${result.exact_matches}; probable matches retained: ${result.probable_matches_retained}; proven absent: ${result.proven_absent}`,
  );
  for (const report of result.reports) {
    const starts = report.local.sessions.map(session => session.start).join(',');
    console.log(
      `${report.match.kind.toUpperCase()} | ${report.local.source_name} | ${report.local.title} | sessions=${starts || 'none'}${report.match.reasons.length ? ` | ${report.match.reasons.join(', ')}` : ''}`,
    );
  }
  if (!APPLY) {
    console.log('Dry run only. No database rows were deleted.');
  } else {
    console.log(
      `Deleted ${result.deleted} proven-absent submitted row(s) after archiving each snapshot.`,
    );
  }
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(error => {
    console.error(
      `CommunityHub content reconciliation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    process.exit(1);
  });
}
