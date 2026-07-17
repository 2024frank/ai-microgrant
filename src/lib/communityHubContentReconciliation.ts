import { createHash } from 'node:crypto';
import type { PoolConnection, ResultSetHeader } from 'mysql2/promise';
import pool from './db';
import {
  fetchCommunityHubInventory,
  findBestContentMatch,
  normalizeContentSessions,
  type ComparableEventContent,
  type CommunityHubInventory,
  type CommunityHubInventoryPost,
  type ContentMatch,
  type ContentSession,
} from './communityHubInventory';

const DEFAULT_MIN_AGE_MINUTES = 60;
const LOCK_NAME = 'communityhub-content-reconcile';

type LocalRow = ComparableEventContent & {
  id: number;
  source_id: number;
  source_name: string;
  title: string;
  event_type: string;
  description: string;
  extended_description: string | null;
  calendar_source_url: string | null;
  sessions: unknown;
  dedup_key: string | null;
  status: string;
  communityhub_moderation_status: string;
  updated_at: Date | string;
};

export type ContentReconciliationReport = {
  local: {
    event_id: number;
    source_id: number;
    source_name: string;
    title: string;
    event_type: string;
    description: string;
    extended_description: string | null;
    calendar_source_url: string | null;
    sessions: ContentSession[];
    moderation: string;
    updated_at: Date | string;
  };
  match: {
    kind: ContentMatch['kind'];
    reasons: string[];
    remote?: CommunityHubInventoryPost;
  };
};

export type ContentReconciliationResult = {
  mode: 'dry-run' | 'apply';
  inventory: {
    approved: number;
    pending: number;
    pages: number;
    reported_count: number;
    reported_unapproved_count: number | null;
    sha256: string;
  };
  candidate_rows: number;
  expired_or_invalid_session_rows: number;
  eligible_waiting_rows: number;
  exact_matches: number;
  probable_matches_retained: number;
  proven_absent: number;
  deleted: number;
  deleted_event_ids: number[];
  apply_skips: Array<{
    event_id: number;
    reason: 'no_longer_eligible' | 'changed_since_dry_run' | 'now_expired' | 'content_match_found';
  }>;
  reports: ContentReconciliationReport[];
};

function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    typeof item === 'bigint' ? item.toString() : item
  ));
}

function inventoryDigest(inventory: CommunityHubInventory): string {
  const canonical = inventory.posts
    .map(post => ({
      title: post.title,
      eventType: post.eventType,
      sessions: post.sessions,
      description: post.description,
      extendedDescription: post.extendedDescription,
      calendarSourceUrl: post.calendarSourceUrl,
      moderation: post.moderation,
    }))
    .sort((left, right) => json(left).localeCompare(json(right)));
  return createHash('sha256').update(json(canonical)).digest('hex');
}

function hasCurrentSession(row: LocalRow, nowSeconds: number): boolean {
  return normalizeContentSessions(row.sessions)
    .some(session => Math.max(session.start, session.end) >= nowSeconds);
}

async function candidateRows(
  connection: PoolConnection,
  minAgeMinutes: number,
): Promise<LocalRow[]> {
  const [rows] = await connection.query(
    `SELECT re.id, re.source_id, s.name AS source_name, re.title,
            re.event_type, re.description, re.extended_description,
            re.calendar_source_url, re.sessions, re.dedup_key, re.status,
            re.communityhub_moderation_status, re.updated_at
     FROM raw_events re
     JOIN sources s ON s.id=re.source_id
     WHERE re.status='submitted'
       AND re.communityhub_post_id IS NOT NULL
       AND re.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
       AND NOT EXISTS (
         SELECT 1 FROM communityhub_updates cu
         WHERE cu.raw_event_id=re.id AND cu.status IN ('sending','ambiguous')
       )
       AND NOT EXISTS (
         SELECT 1 FROM communityhub_submissions cs
         WHERE cs.raw_event_id=re.id
           AND cs.status IN ('prepared','sending','accepted_unreconciled')
       )
     ORDER BY re.id`,
    [minAgeMinutes],
  );
  return Array.isArray(rows) ? rows as LocalRow[] : [];
}

function binaryEvidence(value: unknown): unknown {
  if (!Buffer.isBuffer(value)) return value;
  return {
    omitted_binary: true,
    byte_length: value.byteLength,
    sha256: createHash('sha256').update(value).digest('hex'),
  };
}

async function relatedSnapshot(connection: PoolConnection, row: Record<string, unknown>) {
  const tables = [
    'field_edit_log',
    'rejection_log',
    'review_sessions',
    'communityhub_submissions',
    'communityhub_updates',
    'needs_fix',
    'notifications',
  ];
  const related: Record<string, unknown> = {};
  for (const table of tables) {
    const [records] = await connection.query(
      `SELECT * FROM \`${table}\` WHERE raw_event_id=?`,
      [row.id],
    );
    related[table] = records;
  }
  return {
    raw_event: {
      ...row,
      image_data: binaryEvidence(row.image_data),
      pending_image_data: binaryEvidence(row.pending_image_data),
    },
    related,
  };
}

function reportFor(row: LocalRow, match: ContentMatch): ContentReconciliationReport {
  return {
    local: {
      event_id: Number(row.id),
      source_id: Number(row.source_id),
      source_name: row.source_name,
      title: row.title,
      event_type: row.event_type,
      description: row.description,
      extended_description: row.extended_description,
      calendar_source_url: row.calendar_source_url,
      sessions: normalizeContentSessions(row.sessions),
      moderation: row.communityhub_moderation_status,
      updated_at: row.updated_at,
    },
    match: {
      kind: match.kind,
      reasons: match.reasons,
      ...(match.remote ? { remote: match.remote } : {}),
    },
  };
}

async function applyAbsentRows(
  connection: PoolConnection,
  rows: LocalRow[],
  inventory: CommunityHubInventory,
  digest: string,
  minAgeMinutes: number,
  nowSeconds: number,
): Promise<{
  deletedEventIds: number[];
  skips: ContentReconciliationResult['apply_skips'];
}> {
  const [[lock]] = await connection.query(
    'SELECT GET_LOCK(?, 0) AS acquired',
    [LOCK_NAME],
  ) as any;
  if (!(lock?.acquired === 1 || lock?.acquired === '1' || lock?.acquired === true)) {
    throw new Error('another CommunityHub content reconciliation is already running');
  }

  const deletedEventIds: number[] = [];
  const skips: ContentReconciliationResult['apply_skips'] = [];
  try {
    await connection.beginTransaction();
    for (const candidate of rows) {
      // Repeat every eligibility predicate while holding the event row lock.
      // A publish retry or edit that began after the dry-run must win over
      // cleanup and make this event ineligible for deletion.
      const [[current]] = await connection.query(
        `SELECT re.*, s.name AS source_name
         FROM raw_events re
         JOIN sources s ON s.id=re.source_id
         WHERE re.id=? AND re.status='submitted'
           AND re.communityhub_post_id IS NOT NULL
           AND re.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
           AND NOT EXISTS (
             SELECT 1 FROM communityhub_updates cu
             WHERE cu.raw_event_id=re.id AND cu.status IN ('sending','ambiguous')
           )
           AND NOT EXISTS (
             SELECT 1 FROM communityhub_submissions cs
             WHERE cs.raw_event_id=re.id
               AND cs.status IN ('prepared','sending','accepted_unreconciled')
           )
         LIMIT 1 FOR UPDATE`,
        [candidate.id, minAgeMinutes],
      ) as any;
      if (!current) {
        skips.push({ event_id: candidate.id, reason: 'no_longer_eligible' });
        continue;
      }
      if (new Date(current.updated_at).getTime() !== new Date(candidate.updated_at).getTime()) {
        skips.push({ event_id: candidate.id, reason: 'changed_since_dry_run' });
        continue;
      }
      if (!hasCurrentSession(current, nowSeconds)) {
        skips.push({ event_id: candidate.id, reason: 'now_expired' });
        continue;
      }
      if (findBestContentMatch(current, inventory.posts).kind !== 'none') {
        skips.push({ event_id: candidate.id, reason: 'content_match_found' });
        continue;
      }

      const snapshot = await relatedSnapshot(connection, current);
      await connection.query(
        `INSERT INTO communityhub_reconciliation_deletions
         (raw_event_id, source_id, event_title, dedup_key, reason,
          event_snapshot, remote_inventory_sha256,
          remote_approved_count, remote_pending_count)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [
          current.id,
          current.source_id,
          current.title,
          current.dedup_key,
          'absent_from_complete_approved_pending_content_inventory',
          json(snapshot),
          digest,
          inventory.approved,
          inventory.pending,
        ],
      );
      // These legacy tables intentionally have no raw_events foreign key.
      await connection.query('DELETE FROM needs_fix WHERE raw_event_id=?', [current.id]);
      await connection.query('DELETE FROM notifications WHERE raw_event_id=?', [current.id]);
      await connection.query('DELETE FROM communityhub_submissions WHERE raw_event_id=?', [current.id]);
      // FK-backed edit/review/update rows are removed by raw_events cascades.
      const [deletion] = await connection.query<ResultSetHeader>(
        `DELETE FROM raw_events
         WHERE id=? AND status='submitted'`,
        [current.id],
      );
      if (deletion.affectedRows === 1) deletedEventIds.push(Number(current.id));
    }
    await connection.commit();
    return { deletedEventIds, skips };
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => undefined);
  }
}

/**
 * Compare local submitted rows to a fully validated CommunityHub snapshot by
 * content. Apply mode deletes only current/future rows with no exact or strong
 * content match and archives recoverable evidence before each deletion.
 */
export async function reconcileCommunityHubContent(options: {
  apply?: boolean;
  minAgeMinutes?: number;
  fetcher?: typeof fetch;
} = {}): Promise<ContentReconciliationResult> {
  const apply = options.apply === true;
  const requestedAge = Number.isFinite(options.minAgeMinutes)
    ? Math.trunc(options.minAgeMinutes!)
    : DEFAULT_MIN_AGE_MINUTES;
  const minAgeMinutes = Math.min(Math.max(requestedAge, 1), 24 * 60);

  // Fetch and validate the complete remote snapshot before opening a mutation
  // transaction. HTTP errors, unknown moderation values, truncation, and
  // incomplete pagination can never become deletion evidence.
  const inventory = await fetchCommunityHubInventory(options.fetcher);
  const digest = inventoryDigest(inventory);
  const connection = await pool.getConnection();
  try {
    const rows = await candidateRows(connection, minAgeMinutes);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const currentRows = rows.filter(row => hasCurrentSession(row, nowSeconds));
    const matched = currentRows.map(row => ({
      row,
      match: findBestContentMatch(row, inventory.posts),
    }));
    const absent = matched
      .filter(item => item.match.kind === 'none')
      .map(item => item.row);
    const applied = apply
      ? await applyAbsentRows(
        connection,
        absent,
        inventory,
        digest,
        minAgeMinutes,
        nowSeconds,
      )
      : { deletedEventIds: [], skips: [] };

    return {
      mode: apply ? 'apply' : 'dry-run',
      inventory: {
        approved: inventory.approved,
        pending: inventory.pending,
        pages: inventory.pages,
        reported_count: inventory.reportedCount,
        reported_unapproved_count: inventory.reportedUnapprovedCount,
        sha256: digest,
      },
      candidate_rows: rows.length,
      expired_or_invalid_session_rows: rows.length - currentRows.length,
      eligible_waiting_rows: currentRows.length,
      exact_matches: matched.filter(item => item.match.kind === 'exact').length,
      probable_matches_retained: matched.filter(item => item.match.kind === 'probable').length,
      proven_absent: absent.length,
      deleted: applied.deletedEventIds.length,
      deleted_event_ids: applied.deletedEventIds,
      apply_skips: applied.skips,
      reports: matched.map(item => reportFor(item.row, item.match)),
    };
  } finally {
    connection.release();
  }
}
