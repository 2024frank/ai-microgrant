import Anthropic from '@anthropic-ai/sdk';
import pool from './db';
import { getRejectionHistory } from './rejectionHistory';
import { fetchUnreadEmails, extractEventsFromEmail, markEmailsRead } from './emailFetch';
import {
  persistExtractedEvents,
} from './eventIngestion';
import {
  OBERLIN_POST_TYPE_IDS,
  OBERLIN_POST_TYPE_LABELS,
} from './communityHubPayload';

const DEFAULT_EMAILS_PER_RUN = 5;
const MAX_EMAILS_PER_RUN = 25;
const DEFAULT_EMAIL_RUN_TIMEOUT_MS = 4 * 60 * 1000;

type RunEvidence = {
  status?: string;
  events_found?: number | string;
  events_extracted?: number | string;
  events_skipped_dup?: number | string;
  events_errored?: number | string;
  persisted_events?: number | string;
};

function nonNegativeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

async function readRunEvidence(runId: number): Promise<RunEvidence | null> {
  const [[run]] = await pool.query(
    `SELECT ar.status, ar.events_found, ar.events_extracted,
            ar.events_skipped_dup, ar.events_errored,
            (SELECT COUNT(*) FROM raw_events re WHERE re.agent_run_id=ar.id) AS persisted_events
     FROM agent_runs ar WHERE ar.id=?`,
    [runId],
  ) as any;
  return run ?? null;
}

function hasDirectPostEvidence(run: RunEvidence | null): run is RunEvidence {
  if (!run) return false;
  return run.status === 'completed'
    || nonNegativeCount(run.persisted_events) > 0
    || nonNegativeCount(run.events_found) > 0
    || nonNegativeCount(run.events_extracted) > 0
    || nonNegativeCount(run.events_skipped_dup) > 0;
}

function emailBatchLimit(): number {
  const configured = Number.parseInt(process.env.EMAIL_MAX_PER_RUN || '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_EMAILS_PER_RUN;
  return Math.min(Math.max(configured, 1), MAX_EMAILS_PER_RUN);
}

function emailRunTimeoutMs(): number {
  const configured = Number(process.env.EMAIL_RUN_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_EMAIL_RUN_TIMEOUT_MS;
  }
  return Math.min(Math.max(configured, 5_000), DEFAULT_EMAIL_RUN_TIMEOUT_MS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown ingestion error';
}

const POST_TYPE_CONTRACT = OBERLIN_POST_TYPE_IDS
  .map(id => `${id} ${OBERLIN_POST_TYPE_LABELS[id]}`)
  .join('; ');

const EXTRACTION_CONTRACT = `Use the CommunityHub payload contract exactly:
- eventType is only "ot" (event), "an" (announcement), or "jp" (job). Categories never go in eventType.
- title: 1-60 characters; description: one complete sentence, 10-200 characters; extendedDescription: at most 1000 characters.
- sponsors is a non-empty array containing only organizers or sponsors explicitly supported by the source.
- postTypeId is a non-empty array using only these Oberlin categories: ${POST_TYPE_CONTRACT}.
- sessions is a non-empty array. startTime/endTime are integer Unix seconds interpreted in America/New_York; never return ISO strings or millisecond timestamps. Do not estimate an unstated end time—use the stated start time for both values when no end is provided.
- Include only future or currently ongoing records; at least one session must not have ended.
- locationType is ph2/on/bo/ne. ph2 and bo require location; on and bo require urlLink.
- display is all (all public screens), ps (school screens), sps (school + public screens), or ss (specific screens). ss requires one or more positive integer screensIds.
- Never invent facts. Do not infer missing details or reuse stale facts. Re-read the current source each run and return only the JSON array of events.`;

function getClient(apiKey: string) {
  // In test env the SDK is mocked — don't throw on missing key
  const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
  return new Anthropic({ apiKey: key });
}

/**
 * Trigger a Claude agent run for a given source.
 * Uses the Sessions long-poll API with a serverless-safe deadline and completes
 * when the agent fires session.status_idle.
 *
 * @param sourceId       DB id of the sources row
 * @param runId          Pre-created agent_runs row id (from the trigger route)
 * @param anthropicKey   ANTHROPIC_API_KEY forwarded from the route handler
 * @param environmentId  SOURCE_BUILDER_ENVIRONMENT_ID forwarded from the route handler
 */
export async function triggerAgentRun(
  sourceId: number,
  runId: number,
  anthropicKey: string,
  environmentId: string,
  overrideUserMessage?: string,
  options: { expectedCorrectionEventId?: number } = {},
) {
  try {
    const [[source]] = await pool.query(
      'SELECT * FROM sources WHERE id = ? AND active = 1', [sourceId]
    ) as any;
    if (!source) throw new Error(`Source ${sourceId} not found or inactive`);

    // Source-scoped, reviewer-verified feedback is retrieved for later runs.
    // This is persistent prompt context, not autonomous model retraining.
    const { prompt_block } = await getRejectionHistory(sourceId, 50);

    // Trigger the agent via Anthropic's managed-agents Sessions API.
    // Each source has its own agent_id; environment and vault are shared.
    const userMessage = [
      overrideUserMessage ?? 'Run extraction now.',
      EXTRACTION_CONTRACT,
      prompt_block,
    ].filter(Boolean).join('\n\n');

    const client = getClient(anthropicKey);

    // 1. Create a session for this agent
    const session = await client.beta.sessions.create({
      agent:          source.agent_id,
      environment_id: environmentId,
    } as any);

    // Persist the session id so a stop request can tear it down API-side
    // (the SDK has no cancel — delete is the only teardown). Best-effort.
    try {
      await pool.query('UPDATE agent_runs SET session_id = ? WHERE id = ?', [session.id, runId]);
    } catch {
      // Older deployments may not have the optional session_id column yet.
    }

    // 2. Send the user message to trigger the agent
    await client.beta.sessions.events.send(session.id, {
      events: [{ type: 'user.message', content: [{ type: 'text', text: userMessage }] }],
    } as any);

    // 3. Long-poll events.list() with created_at[gt] cursor until session.status_idle.
    // Keep the deadline below the route's five-minute serverless limit so the
    // catch block can persist a useful failure instead of leaving a stale run.
    console.log(`[agentRunner] run=${runId} session=${session.id} polling start`);
    const outputChunks: string[] = [];
    let afterCreatedAt: string | undefined;
    let done = false;
    const configuredTimeout = Number(process.env.AGENT_RUN_TIMEOUT_MS);
    const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 4 * 60 * 1000)
      : 4 * 60 * 1000;
    const deadline = Date.now() + TIMEOUT_MS;

    while (!done) {
      if (Date.now() > deadline) {
        throw new Error(`Agent run timed out after ${Math.round(TIMEOUT_MS / 1000)} seconds (session ${session.id})`);
      }

      // Check if this run was stopped externally before each poll
      const statusResult = await pool.query(
        'SELECT status FROM agent_runs WHERE id = ?', [runId]
      ) as any;
      const currentRun = Array.isArray(statusResult?.[0]) ? statusResult[0][0] : null;
      if (currentRun?.status !== 'running') {
        if (currentRun?.status === 'stopped') {
          console.log(`[agentRunner] run=${runId} stopped externally — aborting`);
          return { run_id: runId, inserted: 0, events: [] };
        }
        throw new Error('Agent run lease is no longer active');
      }

      const page = await client.beta.sessions.events.list(session.id, {
        ...(afterCreatedAt ? { 'created_at[gt]': afterCreatedAt } : {}),
        limit: 100,
        order: 'asc',
      } as any) as any;

      const events: any[] = page.data ?? [];

      for (const event of events) {
        if (event.created_at) afterCreatedAt = event.created_at;

        if (event.type === 'agent.message') {
          for (const block of (event.content ?? []) as any[]) {
            if (block.type === 'text' && block.text) {
              outputChunks.push(block.text);
            }
          }
        }

        if (event.type === 'session.status_idle') {
          const stopReason = event.stop_reason;
          if (stopReason?.type !== 'requires_action') {
            console.log(`[agentRunner] run=${runId} session idle — extraction complete`);
            done = true;
            break;
          }
        }
      }

      // Brief delay between every poll to avoid hammering the Sessions API
      if (!done) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    const outputText = outputChunks.join('');

    const jsonMatch = outputText.match(/\[[\s\S]*\]/);

    // Some agents submit through the ingest endpoint rather than returning a
    // JSON array. Only accept that path when this exact run has durable output
    // or counters; otherwise prose/no output is an extraction failure.
    if (!jsonMatch) {
      const evidence = await readRunEvidence(runId);
      if (evidence?.status === 'stopped') {
        return { run_id: runId, inserted: 0, skipped: 0, invalid: 0, events: [] };
      }
      if (!hasDirectPostEvidence(evidence)) {
        throw new Error('Agent returned no JSON array and no direct-post output was recorded for this run');
      }
      await pool.query(
        `UPDATE agent_runs SET status='completed', finished_at=NOW()
         WHERE id=? AND status='running'`,
        [runId]
      );
      return {
        run_id: runId,
        inserted: nonNegativeCount(evidence.events_extracted),
        skipped: nonNegativeCount(evidence.events_skipped_dup),
        invalid: nonNegativeCount(evidence.events_errored),
        events: [],
      };
    }

    let events: any[];
    try {
      events = JSON.parse(jsonMatch[0]);
    } catch {
      const evidence = await readRunEvidence(runId);
      if (evidence?.status === 'stopped') {
        return { run_id: runId, inserted: 0, skipped: 0, invalid: 0, events: [] };
      }
      if (!hasDirectPostEvidence(evidence)) {
        throw new Error('Agent returned malformed JSON and no direct-post output was recorded for this run');
      }
      await pool.query(
        `UPDATE agent_runs SET status='completed', finished_at=NOW()
         WHERE id=? AND status='running'`,
        [runId]
      );
      return {
        run_id: runId,
        inserted: nonNegativeCount(evidence.events_extracted),
        skipped: nonNegativeCount(evidence.events_skipped_dup),
        invalid: nonNegativeCount(evidence.events_errored),
        events: [],
      };
    }

    if (!Array.isArray(events)) {
      throw new Error('Agent output JSON must be an array');
    }

    const preWriteStatusResult = await pool.query(
      'SELECT status FROM agent_runs WHERE id=?',
      [runId],
    ) as any;
    const preWriteRun = Array.isArray(preWriteStatusResult?.[0])
      ? preWriteStatusResult[0][0]
      : null;
    if (preWriteRun?.status === 'stopped') {
      return { run_id: runId, inserted: 0, skipped: 0, invalid: 0, events: [] };
    }
    if (preWriteRun?.status !== 'running') {
      throw new Error('Agent run lease is no longer active');
    }

    // Write events to MySQL
    const result = await persistExtractedEvents(events, source, runId, options);
    // Close run with stats
    await pool.query(
      `UPDATE agent_runs SET
         status='completed', finished_at=NOW(),
         events_found=?, events_extracted=?, events_skipped_dup=?,
         events_errored=?, error_log=?
       WHERE id=? AND status='running'`,
      [
        events.length,
        result.inserted.length,
        result.duplicates,
        result.invalid,
        result.errors.length ? JSON.stringify(result.errors) : null,
        runId,
      ]
    );

    return {
      run_id: runId,
      inserted: result.inserted.length,
      skipped: result.skipped,
      invalid: result.invalid,
      errors: result.errors,
      events: result.inserted,
    };

  } catch (err: any) {
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
       WHERE id=? AND status='running'`,
      [JSON.stringify([errorMessage(err)]), runId]
    );
    throw err;
  }
}

/**
 * Email-based ingestion: fetch unread emails → Claude extraction → DB write.
 * Called from the schedule route when source_type = 'email'.
 */
export async function triggerEmailIngest(sourceId: number, runId: number): Promise<{ run_id: number; inserted: number; skipped: number }> {
  try {
    const [[source]] = await pool.query(
      'SELECT * FROM sources WHERE id = ? AND active = 1', [sourceId]
    ) as any;
    if (!source) throw new Error(`Source ${sourceId} not found or inactive`);

    const limit = emailBatchLimit();
    const deadline = Date.now() + emailRunTimeoutMs();
    const emails = await fetchUnreadEmails(limit);
    console.log(`[emailIngest] run=${runId} fetched ${emails.length} unread emails`);

    if (emails.length === 0) {
      await pool.query(
        `UPDATE agent_runs SET status='completed', finished_at=NOW(),
         events_found=0, events_extracted=0, events_skipped_dup=0,
         events_errored=0, error_log=NULL
         WHERE id=? AND status='running'`,
        [runId]
      );
      return { run_id: runId, inserted: 0, skipped: 0 };
    }

    let eventsFound = 0;
    let inserted = 0;
    let skipped = 0;
    let duplicateSkips = 0;
    let invalid = 0;
    let successfulEmails = 0;
    let attemptedEmails = 0;
    let leaseLost = false;
    const failures: Array<Record<string, unknown>> = [];

    for (const email of emails) {
      if (Date.now() >= deadline) {
        console.log(`[emailIngest] run=${runId} reached its time budget; remaining messages stay unread`);
        break;
      }

      const [[run]] = await pool.query(
        'SELECT status FROM agent_runs WHERE id=?',
        [runId],
      ) as any;
      if (run?.status !== 'running') {
        leaseLost = true;
        break;
      }

      attemptedEmails++;
      try {
        const requestTimeoutMs = Math.max(1_000, Math.min(60_000, deadline - Date.now()));
        const events = await extractEventsFromEmail(email, requestTimeoutMs);
        eventsFound += events.length;

        const [[postExtractionRun]] = await pool.query(
          'SELECT status FROM agent_runs WHERE id=?',
          [runId],
        ) as any;
        if (postExtractionRun?.status !== 'running') {
          leaseLost = true;
          break;
        }

        // Tag each event with where it came from
        for (const ev of events) {
          if (!ev.calendarSourceName) ev.calendarSourceName = email.from || source.name;
        }

        if (events.length > 0) {
          // Persist one email at a time so successful messages can be
          // checkpointed even if a later parser/model call fails.
          const result = await persistExtractedEvents(events, source, runId);
          inserted += result.inserted.length;
          skipped += result.skipped;
          duplicateSkips += result.duplicates;
          invalid += result.invalid;

          const fatalReports = result.errors.filter(report => !report.inserted);
          if (fatalReports.length > 0) {
            failures.push({
              uid: email.uid,
              subject: email.subject,
              stage: 'persist',
              error: 'One or more extracted events could not be persisted',
              reports: fatalReports,
            });
            console.error(`[emailIngest] run=${runId} email uid=${email.uid} has ${fatalReports.length} fatal event errors; leaving unread`);
            continue;
          }
        }

        // [] is a legitimate, successfully parsed result. Mark it read just
        // like a successfully persisted or duplicate-only event email.
        const [[preCheckpointRun]] = await pool.query(
          'SELECT status FROM agent_runs WHERE id=?',
          [runId],
        ) as any;
        if (preCheckpointRun?.status !== 'running') {
          leaseLost = true;
          break;
        }
        await markEmailsRead([email.uid]);
        successfulEmails++;
        console.log(`[emailIngest] run=${runId} email uid=${email.uid} subject="${email.subject}" → ${events.length} events`);
      } catch (error) {
        invalid++;
        const message = errorMessage(error);
        failures.push({
          uid: email.uid,
          subject: email.subject,
          stage: 'extract_or_checkpoint',
          error: message,
        });
        console.error(`[emailIngest] run=${runId} email uid=${email.uid} failed:`, message);
      }
    }

    if (leaseLost) {
      return { run_id: runId, inserted, skipped };
    }

    const failedBatch = attemptedEmails > 0 && successfulEmails === 0 && failures.length > 0;
    await pool.query(
      `UPDATE agent_runs SET status=?, finished_at=NOW(),
       events_found=?, events_extracted=?, events_skipped_dup=?, events_errored=?, error_log=?
       WHERE id=? AND status='running'`,
      [
        failedBatch ? 'failed' : 'completed',
        eventsFound,
        inserted,
        duplicateSkips,
        invalid,
        failures.length ? JSON.stringify(failures) : null,
        runId,
      ]
    );

    if (failedBatch) {
      throw new Error(`All ${attemptedEmails} attempted email${attemptedEmails === 1 ? '' : 's'} failed; messages remain unread`);
    }

    return {
      run_id: runId,
      inserted,
      skipped,
    };
  } catch (error) {
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
       WHERE id=? AND status='running'`,
      [JSON.stringify([errorMessage(error)]), runId]
    );
    throw error;
  }
}
