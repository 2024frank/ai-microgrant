import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import type { PoolConnection } from 'mysql2/promise';
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
import { COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS } from './communityHubInventory';
import { withIntakeInventoryToken } from './intakeInventoryAccess';
import {
  AGENT_CONTINUATION_LEASE_SECONDS,
  AGENT_CONTINUATION_POLL_MS,
  AGENT_CONTINUATION_SLICE_MS,
  agentSessionMaxMinutes,
} from './agentRunPolicy';

const DEFAULT_EMAILS_PER_RUN = 5;
const MAX_EMAILS_PER_RUN = 25;
const DEFAULT_EMAIL_RUN_TIMEOUT_MS = 4 * 60 * 1000;
const DEFAULT_JSON_REPAIR_ATTEMPTS = 1;
const MAX_JSON_REPAIR_ATTEMPTS = 2;

type AgentOutputIssue = 'missing_array' | 'malformed_json' | 'wrong_shape';

type AgentOutputParseResult =
  | { ok: true; events: any[] }
  | { ok: false; issue: AgentOutputIssue };

type SessionTurnResult = {
  outputText: string;
  afterCreatedAt?: string;
  pending: boolean;
  stopped: boolean;
};

type AgentRunProgress = {
  run_id: number;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  pending: boolean;
  busy?: boolean;
  inserted: number;
  skipped: number;
  invalid: number;
  errors?: any[];
  events: any[];
};

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

function jsonRepairAttempts(): number {
  const configured = Number.parseInt(process.env.AGENT_JSON_REPAIR_ATTEMPTS || '', 10);
  if (!Number.isFinite(configured)) return DEFAULT_JSON_REPAIR_ATTEMPTS;
  return Math.min(Math.max(configured, 0), MAX_JSON_REPAIR_ATTEMPTS);
}

function balancedArrayCandidates(text: string): string[] {
  const candidates: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];

    if (start < 0) {
      if (char === '[') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function isPlausibleEventArray(value: unknown): value is any[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;

  const eventKeys = ['eventType', 'title', 'description', 'sessions', 'postTypeId', 'locationType'];
  return value.every(item => (
    item !== null
    && typeof item === 'object'
    && !Array.isArray(item)
    && eventKeys.some(key => Object.prototype.hasOwnProperty.call(item, key))
  ));
}

function parseAgentOutput(outputText: string): AgentOutputParseResult {
  const trimmed = outputText.trim();
  if (!trimmed) return { ok: false, issue: 'missing_array' };

  // Prefer a response that is already pure JSON. This preserves the existing
  // contract while allowing a fenced response as a tolerant fallback.
  try {
    const parsed = JSON.parse(trimmed);
    return isPlausibleEventArray(parsed)
      ? { ok: true, events: parsed }
      : { ok: false, issue: 'wrong_shape' };
  } catch {
    // Continue with bounded, deterministic extraction below.
  }

  const fencedCandidates = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
    .map(match => match[1].trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  let sawWrongShape = false;
  for (const candidate of fencedCandidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlausibleEventArray(parsed)) return { ok: true, events: parsed };
      sawWrongShape = true;
    } catch {
      // A later fence may contain the actual array.
    }
  }

  // The old greedy /\[[\s\S]*\]/ match merged separate arrays into invalid
  // JSON. Parse complete balanced arrays independently and prefer the largest
  // event-shaped candidate. Brackets inside JSON strings are ignored.
  const candidates = balancedArrayCandidates(trimmed)
    .sort((left, right) => right.length - left.length);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlausibleEventArray(parsed)) return { ok: true, events: parsed };
      if (Array.isArray(parsed)) sawWrongShape = true;
    } catch {
      // Keep looking; model prose can contain non-JSON bracketed text.
    }
  }

  if (sawWrongShape) return { ok: false, issue: 'wrong_shape' };
  return {
    ok: false,
    issue: trimmed.includes('[') ? 'malformed_json' : 'missing_array',
  };
}

function outputIssueMessage(issue: AgentOutputIssue, repairAttempts: number): string {
  const suffix = repairAttempts > 0
    ? ` after ${repairAttempts} bounded repair attempt${repairAttempts === 1 ? '' : 's'}`
    : '';
  if (issue === 'missing_array') {
    return `Agent returned no JSON array and no direct-post output was recorded for this run${suffix}`;
  }
  if (issue === 'wrong_shape') {
    return `Agent output JSON must be an event array${suffix}`;
  }
  return `Agent returned malformed JSON and no direct-post output was recorded for this run${suffix}`;
}

function repairPrompt(issue: AgentOutputIssue): string {
  const reason = issue === 'missing_array'
    ? 'no JSON array was present'
    : issue === 'wrong_shape'
      ? 'the top-level JSON value was not an event array'
      : 'the JSON array was syntactically invalid';
  return [
    `Your previous extraction response could not be accepted because ${reason}.`,
    'Do not browse again, invoke tools, or POST to the ingest endpoint. Correct only the event data already gathered in this session.',
    'Return exactly one raw JSON array that follows the payload contract from the prior instruction.',
    'If there are no eligible events, return []. Do not include Markdown fences, commentary, ellipses, or trailing commas.',
  ].join('\n');
}

async function pollSessionTurn(
  client: any,
  sessionId: string,
  runId: number,
  deadline: number,
  timeoutMs: number,
  initialCursor?: string,
): Promise<SessionTurnResult> {
  const outputChunks: string[] = [];
  let afterCreatedAt = initialCursor;
  let pageCursor: string | undefined;

  while (true) {
    if (Date.now() >= deadline) {
      console.log(
        `[agentRunner] run=${runId} monitoring slice ended after ${Math.round(timeoutMs / 1000)} seconds; session remains resumable`,
      );
      return {
        outputText: outputChunks.join(''),
        afterCreatedAt,
        pending: true,
        stopped: false,
      };
    }

    const statusResult = await pool.query(
      'SELECT status FROM agent_runs WHERE id = ?', [runId]
    ) as any;
    const currentRun = Array.isArray(statusResult?.[0]) ? statusResult[0][0] : null;
    if (currentRun?.status !== 'running') {
      if (currentRun?.status === 'stopped') {
        console.log(`[agentRunner] run=${runId} stopped externally — aborting`);
        return { outputText: '', afterCreatedAt, pending: false, stopped: true };
      }
      throw new Error('Agent run lease is no longer active');
    }

    const page = await client.beta.sessions.events.list(sessionId, {
      ...(pageCursor
        ? { page: pageCursor }
        : afterCreatedAt
          ? { 'created_at[gt]': afterCreatedAt }
          : {}),
      limit: 100,
      order: 'asc',
    } as any) as any;

    const events: any[] = page.data ?? [];
    pageCursor = typeof page.next_page === 'string' && page.next_page
      ? page.next_page
      : undefined;
    const hasBufferedPage = Boolean(pageCursor) || events.length >= 100;
    let turnComplete = false;
    for (const event of events) {
      // Managed-agent events expose processed_at even though the list filter
      // is still named created_at[gt]. Using the nonexistent created_at field
      // pins every poll to page one and hides terminal events after item 100.
      const eventCursor = event.processed_at ?? event.created_at;
      if (eventCursor) afterCreatedAt = eventCursor;

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
          turnComplete = true;
          break;
        }
      }
    }

    if (turnComplete) {
      return {
        outputText: outputChunks.join(''),
        afterCreatedAt,
        pending: false,
        stopped: false,
      };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0 && !hasBufferedPage) {
      await new Promise(resolve => setTimeout(resolve, Math.min(3000, remainingMs)));
    }
  }
}

async function completeFromDirectPost(runId: number, evidence: RunEvidence) {
  await pool.query(
    `UPDATE agent_runs SET status='completed', finished_at=NOW()
     WHERE id=? AND status='running'`,
    [runId]
  );
  return {
    run_id: runId,
    status: 'completed' as const,
    pending: false,
    inserted: nonNegativeCount(evidence.events_extracted),
    skipped: nonNegativeCount(evidence.events_skipped_dup),
    invalid: nonNegativeCount(evidence.events_errored),
    events: [],
  };
}

function pendingRun(runId: number, busy = false): AgentRunProgress {
  return {
    run_id: runId,
    status: 'running',
    pending: true,
    ...(busy ? { busy: true } : {}),
    inserted: 0,
    skipped: 0,
    invalid: 0,
    events: [],
  };
}

function stoppedRun(runId: number): AgentRunProgress {
  return {
    run_id: runId,
    status: 'stopped',
    pending: false,
    inserted: 0,
    skipped: 0,
    invalid: 0,
    events: [],
  };
}

async function failRun(runId: number, message: string): Promise<AgentRunProgress> {
  await pool.query(
    `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
     WHERE id=? AND status='running'`,
    [JSON.stringify([message]), runId],
  );
  return {
    run_id: runId,
    status: 'failed',
    pending: false,
    inserted: 0,
    skipped: 0,
    invalid: 0,
    errors: [message],
    events: [],
  };
}

async function persistAgentOutput(
  events: any[],
  source: any,
  runId: number,
  options: { expectedCorrectionEventId?: number } = {},
): Promise<AgentRunProgress> {
  const preWriteStatusResult = await pool.query(
    'SELECT status FROM agent_runs WHERE id=?',
    [runId],
  ) as any;
  const preWriteRun = Array.isArray(preWriteStatusResult?.[0])
    ? preWriteStatusResult[0][0]
    : null;
  if (preWriteRun?.status === 'stopped') return stoppedRun(runId);
  if (preWriteRun?.status !== 'running') {
    throw new Error('Agent run lease is no longer active');
  }

  const result = await persistExtractedEvents(events, source, runId, options);
  if (options.expectedCorrectionEventId !== undefined && result.inserted.length !== 1) {
    throw new Error('Correction agent did not return one contract-valid reviewable event');
  }
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
    ],
  );

  return {
    run_id: runId,
    status: 'completed',
    pending: false,
    inserted: result.inserted.length,
    skipped: result.skipped,
    invalid: result.invalid,
    errors: result.errors,
    events: result.inserted,
  };
}

const POST_TYPE_CONTRACT = OBERLIN_POST_TYPE_IDS
  .map(id => `${id} ${OBERLIN_POST_TYPE_LABELS[id]}`)
  .join('; ');

const EXTRACTION_CONTRACT = `Use the CommunityHub payload contract exactly:
- eventType is only "ot" (event), "an" (announcement), or "jp" (job). Categories never go in eventType.
- title: 1-60 characters; description: one complete sentence, 10-200 characters; extendedDescription: at most 1000 characters.
- Announcement titles must state the action the reader can take when the source announces an opportunity: start with the action, for example "Register for…", "Participate in…", "Apply for…", "Recycle…". A bare noun title like "Summer Symphony" is wrong when the source is actually announcing registration for a summer symphony day camp. Never invent an action the source does not support.
- When registration is required by the source, set "registrationUrl" to the exact registration link. The platform places it in the registration button and ends the short description with "Registration required." Never put a registration URL inside description or extendedDescription.
- When the source states the event costs money, keep those cost facts in the description (the platform marks the short description with "Paid event."). Do not claim a cost the source does not state.
- extendedDescription must never contain URLs, the street address, or information that already belongs in the dedicated location, date, time, registration, sponsor, or contact fields. Never state the event's date or time in description or extendedDescription; the sessions field carries the schedule and the calendar displays it. Never pad it with filler or invented content; when the entire source description fits within 200 characters, put it in description and omit extendedDescription entirely. Refer to the venue by its actual name (for example "at Common Ground"), never ambiguously as "here" or "there"; if such a sentence is unnecessary, omit it.
- image_cdn_url is REQUIRED: before returning any event, find its image on the source page (the event photo, flyer, or the page's share image / og:image all count) and set image_cdn_url to that image's public HTTPS URL. An event without its source image is incomplete for review and will be held from publishing. Omit the field only when you actually checked the event's page, including its share metadata, and it displays no image at all.
- website is REQUIRED: set it to the event's public web page URL, normally the page you extracted the event from; when the event has no page of its own, use the organization's website. Never leave it empty.
- fieldNotes is an optional object: whenever you leave out a field the platform expects because the source genuinely provides no value (most importantly image_cdn_url, but also a session end time or the website), add an entry to fieldNotes mapping that field name to one short factual sentence explaining why. State only what you actually checked; never use it to carry a real value and never invent a reason.
- sponsors is a non-empty array containing only organizers or sponsors explicitly supported by the source.
- postTypeId is a non-empty array using only these Oberlin categories: ${POST_TYPE_CONTRACT}.
- sessions is a non-empty array. startTime/endTime are integer Unix seconds interpreted in America/New_York; never return ISO strings or millisecond timestamps. Always extract the stated end time. When an EVENT's source states no end time, use the start time for both values and the platform will hold the draft for a human to set the end (CommunityHub cannot publish an event whose end equals its start); never invent a duration. Announcements use their display window as the session.
- Include only future or currently ongoing records; at least one session must not have ended.
- locationType is ph2/on/bo/ne. ph2 and bo require location; on and bo require urlLink.
- display is all (all public screens), ps (school screens), sps (school + public screens), or ss (specific screens). ss requires one or more positive integer screensIds.
- Never invent facts. Do not infer missing details or reuse stale facts. Re-read the current source each run and return only the JSON array of events.

${COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS}`;

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
    const userMessage = withIntakeInventoryToken([
      overrideUserMessage ?? 'Run extraction now.',
      EXTRACTION_CONTRACT,
      prompt_block,
    ].filter(Boolean).join('\n\n'));

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

    // 3. Poll events.list() until session.status_idle or this serverless slice
    // ends. A pending result is handed to the continuation worker by the route.
    console.log(`[agentRunner] run=${runId} session=${session.id} polling start`);
    const configuredTimeout = Number(process.env.AGENT_RUN_TIMEOUT_MS);
    const TIMEOUT_MS = Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, 4 * 60 * 1000)
      : 4 * 60 * 1000;
    const deadline = Date.now() + TIMEOUT_MS;
    let turn = await pollSessionTurn(
      client,
      session.id,
      runId,
      deadline,
      TIMEOUT_MS,
    );
    if (turn.stopped) return stoppedRun(runId);
    if (turn.pending) return pendingRun(runId);
    console.log(`[agentRunner] run=${runId} session idle — extraction turn complete`);

    let repairAttempts = 0;
    const maxRepairAttempts = jsonRepairAttempts();
    let events: any[];

    while (true) {
      const parsed = parseAgentOutput(turn.outputText);
      if (parsed.ok) {
        // A repair prompt explicitly forbids direct posting, but check anyway
        // before persisting its response so a disobedient repair turn cannot
        // duplicate an event it already submitted.
        if (repairAttempts > 0) {
          const repairEvidence = await readRunEvidence(runId);
          if (repairEvidence?.status === 'stopped') {
            return stoppedRun(runId);
          }
          if (hasDirectPostEvidence(repairEvidence)) {
            return completeFromDirectPost(runId, repairEvidence);
          }
        }
        events = parsed.events;
        break;
      }

      // Preserve the existing direct-post path: prose or malformed output is
      // successful only when this exact run has durable counters or rows.
      const evidence = await readRunEvidence(runId);
      if (evidence?.status === 'stopped') {
        return stoppedRun(runId);
      }
      if (hasDirectPostEvidence(evidence)) {
        return completeFromDirectPost(runId, evidence);
      }

      if (repairAttempts >= maxRepairAttempts) {
        throw new Error(outputIssueMessage(parsed.issue, repairAttempts));
      }

      repairAttempts++;
      console.warn(
        `[agentRunner] run=${runId} invalid agent output (${parsed.issue}); requesting bounded repair ${repairAttempts}/${maxRepairAttempts}`,
      );
      await client.beta.sessions.events.send(session.id, {
        events: [{
          type: 'user.message',
          content: [{ type: 'text', text: repairPrompt(parsed.issue) }],
        }],
      } as any);

      turn = await pollSessionTurn(
        client,
        session.id,
        runId,
        deadline,
        TIMEOUT_MS,
        turn.afterCreatedAt,
      );
      if (turn.stopped) return stoppedRun(runId);
      if (turn.pending) return pendingRun(runId);
      console.log(`[agentRunner] run=${runId} repair turn ${repairAttempts} complete`);
    }
    return persistAgentOutput(events, source, runId, options);

  } catch (err: any) {
    await pool.query(
      `UPDATE agent_runs SET status='failed', finished_at=NOW(), error_log=?
       WHERE id=? AND status='running'`,
      [JSON.stringify([errorMessage(err)]), runId]
    );
    throw err;
  }
}

type ContinuationRunRow = {
  run_id: number;
  run_status: 'running' | 'completed' | 'failed' | 'stopped';
  started_at: Date | string;
  session_id: string | null;
  correction_event_id: number | null;
  id: number;
  name: string;
  agent_id: string;
  active: number | boolean | string;
  [key: string]: unknown;
};

async function listAllSessionEvents(client: any, sessionId: string): Promise<any[]> {
  const events: any[] = [];
  const seenCursors = new Set<string>();
  let page = await client.beta.sessions.events.list(sessionId, {
    limit: 100,
    order: 'asc',
  } as any) as any;

  for (let pageCount = 0; pageCount < 100; pageCount++) {
    events.push(...(page.data ?? []));
    const cursor = typeof page.next_page === 'string' ? page.next_page : '';
    if (!cursor) return events;
    if (seenCursors.has(cursor)) throw new Error('Agent session pagination cursor repeated');
    seenCursors.add(cursor);
    page = await client.beta.sessions.events.list(sessionId, {
      page: cursor,
      limit: 100,
      order: 'asc',
    } as any) as any;
  }

  throw new Error('Agent session exceeded the safe pagination limit');
}

function currentTurn(events: any[]): { outputText: string; repairAttempts: number } {
  let lastUserMessage = -1;
  let userMessages = 0;
  for (let index = 0; index < events.length; index++) {
    if (events[index]?.type === 'user.message') {
      lastUserMessage = index;
      userMessages++;
    }
  }

  const turnEvents = events.slice(lastUserMessage + 1);
  return {
    outputText: turnEvents
      .filter(event => event?.type === 'agent.message')
      .flatMap(event => event.content ?? [])
      .filter((block: any) => block?.type === 'text' && block.text)
      .map((block: any) => block.text)
      .join(''),
    repairAttempts: Math.max(0, userMessages - 1),
  };
}

function retryableContinuationError(error: unknown): boolean {
  const candidate = error as { status?: unknown; code?: unknown } | null;
  const status = Number(candidate?.status);
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true;
  return new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT',
  ]).has(String(candidate?.code || ''));
}

function terminalRunProgress(row: ContinuationRunRow): AgentRunProgress {
  return {
    run_id: Number(row.run_id),
    status: row.run_status,
    pending: false,
    inserted: 0,
    skipped: 0,
    invalid: 0,
    events: [],
  };
}

/**
 * Advance a managed-agent run after its original serverless monitoring slice.
 * This is intentionally one-shot: callers poll it periodically, and only the
 * invocation that observes a terminal idle event paginates and persists output.
 */
export async function continueAgentRun(
  runId: number,
  anthropicKey: string,
): Promise<AgentRunProgress> {
  const lockName = `agent-finalize:${runId}`;
  let lockConn: PoolConnection | null = null;
  let lockAcquired = false;
  try {
    lockConn = await pool.getConnection();
    const [[lock]] = await lockConn.query('SELECT GET_LOCK(?, 0) AS acquired', [lockName]) as any;
    if (Number(lock?.acquired) !== 1) return pendingRun(runId, true);
    lockAcquired = true;

    const [[row]] = await pool.query(
      `SELECT ar.id AS run_id, ar.status AS run_status, ar.started_at,
              ar.session_id, ar.correction_event_id, s.*
       FROM agent_runs ar
       JOIN sources s ON s.id=ar.source_id
       WHERE ar.id=? LIMIT 1`,
      [runId],
    ) as any as [[ContinuationRunRow | undefined]];
    if (!row) throw new Error(`Agent run ${runId} not found`);
    if (row.run_status !== 'running') return terminalRunProgress(row);
    if (!row.session_id) return pendingRun(runId);

    const startedAt = new Date(row.started_at).getTime();
    const maxAgeMs = agentSessionMaxMinutes() * 60_000;
    if (!Number.isFinite(startedAt) || Date.now() - startedAt >= maxAgeMs) {
      const client = getClient(anthropicKey);
      await (client.beta.sessions as any).delete(row.session_id).catch(() => undefined);
      return failRun(
        runId,
        `Agent session exceeded the ${agentSessionMaxMinutes()} minute absolute runtime limit`,
      );
    }

    const client = getClient(anthropicKey);
    const latestPage = await client.beta.sessions.events.list(row.session_id, {
      limit: 5,
      order: 'desc',
    } as any) as any;
    const latest = (latestPage.data ?? [])[0];
    if (!latest) return pendingRun(runId);

    if (latest.type === 'session.status_terminated' || latest.type === 'session.error') {
      return failRun(runId, 'Agent session terminated before producing final output');
    }
    if (latest.type !== 'session.status_idle') return pendingRun(runId);
    if (latest.stop_reason?.type === 'requires_action') {
      return failRun(runId, 'Agent session requires unsupported client-side action');
    }

    const sessionEvents = await listAllSessionEvents(client, row.session_id);
    const { outputText, repairAttempts } = currentTurn(sessionEvents);
    const parsed = parseAgentOutput(outputText);
    if (!parsed.ok) {
      const evidence = await readRunEvidence(runId);
      if (evidence?.status === 'stopped') return stoppedRun(runId);
      if (hasDirectPostEvidence(evidence)) return completeFromDirectPost(runId, evidence);

      const maxRepairAttempts = jsonRepairAttempts();
      if (repairAttempts >= maxRepairAttempts) {
        return failRun(runId, outputIssueMessage(parsed.issue, repairAttempts));
      }

      console.warn(
        `[agentRunner] run=${runId} continuation found invalid output (${parsed.issue}); requesting bounded repair ${repairAttempts + 1}/${maxRepairAttempts}`,
      );
      await client.beta.sessions.events.send(row.session_id, {
        events: [{
          type: 'user.message',
          content: [{ type: 'text', text: repairPrompt(parsed.issue) }],
        }],
      } as any);
      return pendingRun(runId);
    }

    if (repairAttempts > 0) {
      const evidence = await readRunEvidence(runId);
      if (evidence?.status === 'stopped') return stoppedRun(runId);
      if (hasDirectPostEvidence(evidence)) return completeFromDirectPost(runId, evidence);
    }

    return persistAgentOutput(parsed.events, row, runId, {
      expectedCorrectionEventId: row.correction_event_id == null
        ? undefined
        : Number(row.correction_event_id),
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error(`[agentRunner] continuation run=${runId} failed:`, message);
    if (retryableContinuationError(error)) {
      return {
        ...pendingRun(runId),
        errors: [message],
      };
    }
    return failRun(runId, message);
  } finally {
    if (lockConn) {
      let releaseConnection = true;
      if (lockAcquired) {
        try {
          const [[released]] = await lockConn.query(
            'SELECT RELEASE_LOCK(?) AS released',
            [lockName],
          ) as any;
          if (Number(released?.released) !== 1) {
            throw new Error('Database did not confirm continuation lock release');
          }
        } catch (error) {
          console.error(`[agentRunner] continuation lock release failed for run=${runId}:`, error);
          lockConn.destroy();
          releaseConnection = false;
        }
      }
      if (releaseConnection) lockConn.release();
    }
  }
}

/**
 * Monitor one resumable session for a bounded serverless slice. The renewable
 * row lease prevents duplicate UI/workflow requests from creating competing
 * poll loops without tying up a database connection for the whole slice.
 */
export async function monitorAgentRun(
  runId: number,
  anthropicKey: string,
  sliceMs = AGENT_CONTINUATION_SLICE_MS,
): Promise<AgentRunProgress> {
  const leaseToken = randomUUID();
  const [claim] = await pool.query(
    `UPDATE agent_runs
     SET continuation_token=?,
         continuation_lease_until=DATE_ADD(NOW(3), INTERVAL ${AGENT_CONTINUATION_LEASE_SECONDS} SECOND)
     WHERE id=? AND status='running' AND session_id IS NOT NULL
       AND (continuation_lease_until IS NULL OR continuation_lease_until < NOW(3))`,
    [leaseToken, runId],
  ) as any;

  if (Number(claim?.affectedRows || 0) !== 1) {
    const [[row]] = await pool.query(
      'SELECT id AS run_id, status AS run_status FROM agent_runs WHERE id=? LIMIT 1',
      [runId],
    ) as any;
    if (row && row.run_status !== 'running') return terminalRunProgress(row);
    return pendingRun(runId, true);
  }

  const deadline = Date.now() + Math.max(1, sliceMs);
  try {
    while (true) {
      const [renewal] = await pool.query(
        `UPDATE agent_runs
         SET continuation_lease_until=DATE_ADD(NOW(3), INTERVAL ${AGENT_CONTINUATION_LEASE_SECONDS} SECOND)
         WHERE id=? AND status='running' AND continuation_token=?`,
        [runId, leaseToken],
      ) as any;
      if (Number(renewal?.affectedRows || 0) !== 1) {
        const [[row]] = await pool.query(
          'SELECT id AS run_id, status AS run_status FROM agent_runs WHERE id=? LIMIT 1',
          [runId],
        ) as any;
        if (row && row.run_status !== 'running') return terminalRunProgress(row);
        return pendingRun(runId, true);
      }

      const result = await continueAgentRun(runId, anthropicKey);
      if (!result.pending) return result;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return pendingRun(runId);
      await new Promise(resolve => setTimeout(
        resolve,
        Math.min(AGENT_CONTINUATION_POLL_MS, remainingMs),
      ));
    }
  } finally {
    await pool.query(
      `UPDATE agent_runs
       SET continuation_token=NULL, continuation_lease_until=NULL
       WHERE id=? AND continuation_token=?`,
      [runId, leaseToken],
    ).catch(error => {
      console.error(`[agentRunner] continuation lease release failed for run=${runId}:`, error);
    });
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
