import type { PoolConnection } from 'mysql2/promise';
import pool from './db';
import { normalizeCommunityHubPostId } from './communityHubResponse';

type RecoveryOptions = {
  reviewerId?: number | null;
  timeSpentSec?: number | null;
};

export type RecoveredCommunityHubSubmission = {
  submissionId: number;
  postId: string;
  response: unknown;
  recovered: boolean;
};

function storedJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Finish the local half of a CommunityHub POST whose remote success was
 * already durably recorded. The caller must hold the raw_events row lock and
 * have an active transaction. No network call is made here.
 */
export async function recoverSucceededCommunityHubSubmission(
  conn: PoolConnection,
  rawEventId: number | string,
  options: RecoveryOptions = {},
): Promise<RecoveredCommunityHubSubmission | null> {
  const [[submission]] = await conn.query(
    `SELECT id, communityhub_post_id, response, reviewer_id
     FROM communityhub_submissions
     WHERE raw_event_id=? AND status='succeeded'
       AND communityhub_post_id IS NOT NULL
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [rawEventId],
  ) as any;
  if (!submission) return null;

  const postId = normalizeCommunityHubPostId(submission.communityhub_post_id);
  if (!postId) {
    throw new Error('Succeeded CommunityHub submission has an invalid post id');
  }

  const [updated] = await conn.query(
    `UPDATE raw_events
     SET status='submitted', communityhub_post_id=?, validation_errors=NULL,
         publish_started_at=NULL, communityhub_moderation_status='pending',
         communityhub_checked_at=NULL, communityhub_moderation_error=NULL
     WHERE id=? AND status IN ('pending','publishing')
       AND (communityhub_post_id IS NULL OR communityhub_post_id=?)`,
    [postId, rawEventId, postId],
  ) as any;
  const recovered = Number(updated?.affectedRows || 0) === 1;

  if (!recovered) {
    const [[event]] = await conn.query(
      `SELECT status, communityhub_post_id
       FROM raw_events WHERE id=? LIMIT 1`,
      [rawEventId],
    ) as any;
    const linkedPostId = normalizeCommunityHubPostId(event?.communityhub_post_id);
    if (event?.status !== 'submitted' || linkedPostId !== postId) {
      throw new Error('Succeeded CommunityHub submission could not be linked safely');
    }
  }

  if (recovered) {
    const reviewerId = options.reviewerId === undefined
      ? submission.reviewer_id ?? null
      : options.reviewerId;
    const response = typeof submission.response === 'string'
      ? submission.response
      : JSON.stringify(submission.response ?? {});
    await conn.query(
      `INSERT INTO review_sessions
       (raw_event_id, reviewer_id, action, time_spent_sec, submitted_to_ch, ch_response)
       SELECT ?,?,'approved',?,1,?
       WHERE NOT EXISTS (
         SELECT 1 FROM review_sessions
         WHERE raw_event_id=? AND action='approved' AND submitted_to_ch=1
       )`,
      [rawEventId, reviewerId, options.timeSpentSec ?? null, response, rawEventId],
    );
  }

  return {
    submissionId: Number(submission.id),
    postId,
    response: storedJson(submission.response),
    recovered,
  };
}

/** Recover abandoned local finalizations without ever re-POSTing the payload. */
export async function recoverSucceededCommunityHubSubmissions(limit = 20): Promise<number> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const [rows] = await pool.query(
    `SELECT DISTINCT re.id
     FROM raw_events re
     JOIN communityhub_submissions cs ON cs.raw_event_id=re.id
     WHERE re.status IN ('pending','publishing')
       AND cs.status='succeeded'
       AND cs.communityhub_post_id IS NOT NULL
       AND cs.updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     ORDER BY re.id ASC LIMIT ?`,
    [safeLimit],
  ) as any;

  let recovered = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[event]] = await conn.query(
        `SELECT id, status FROM raw_events WHERE id=? LIMIT 1 FOR UPDATE`,
        [row.id],
      ) as any;
      if (!event || !['pending', 'publishing'].includes(event.status)) {
        await conn.rollback();
        continue;
      }
      const result = await recoverSucceededCommunityHubSubmission(conn, Number(row.id));
      await conn.commit();
      if (result?.recovered) recovered += 1;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }
  return recovered;
}

/**
 * A prepared row is explicitly pre-network, so it can be released without any
 * duplicate-post risk. This heals a process crash between the local commit and
 * the durable `sending` claim.
 */
export async function releaseStalePreparedCommunityHubSubmissions(limit = 20): Promise<number> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 50);
  const [rows] = await pool.query(
    `SELECT DISTINCT re.id
     FROM raw_events re
     JOIN communityhub_submissions cs ON cs.raw_event_id=re.id
     WHERE re.status='publishing'
       AND cs.status='prepared'
       AND cs.updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
     ORDER BY re.id ASC LIMIT ?`,
    [safeLimit],
  ) as any;

  let released = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[event]] = await conn.query(
        `SELECT id, status FROM raw_events WHERE id=? LIMIT 1 FOR UPDATE`,
        [row.id],
      ) as any;
      if (!event || event.status !== 'publishing') {
        await conn.rollback();
        continue;
      }
      const [intents] = await conn.query(
        `SELECT id FROM communityhub_submissions
         WHERE raw_event_id=? AND status='prepared' FOR UPDATE`,
        [row.id],
      ) as any;
      if (!Array.isArray(intents) || intents.length === 0) {
        await conn.rollback();
        continue;
      }
      await conn.query(
        `UPDATE communityhub_submissions
         SET status='failed', error_message='Recovered abandoned pre-dispatch submission intent'
         WHERE raw_event_id=? AND status='prepared'`,
        [row.id],
      );
      const [updated] = await conn.query(
        `UPDATE raw_events SET status='pending', publish_started_at=NULL
         WHERE id=? AND status='publishing'`,
        [row.id],
      ) as any;
      await conn.commit();
      if (Number(updated?.affectedRows || 0) === 1) released += 1;
    } catch (error) {
      await conn.rollback().catch(() => undefined);
      throw error;
    } finally {
      conn.release();
    }
  }
  return released;
}
