export const AGENT_CONTINUATION_AFTER_SECONDS = 250;
export const AGENT_CONTINUATION_SLICE_MS = 220_000;
export const AGENT_CONTINUATION_POLL_MS = 5_000;
export const AGENT_CONTINUATION_LEASE_SECONDS = 30;

const DEFAULT_SESSIONLESS_STALE_MINUTES = 10;
const DEFAULT_SESSION_MAX_MINUTES = 30;

function boundedMinutes(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

/**
 * A run that never persisted an Anthropic session is not resumable. Recover it
 * quickly so one dead start worker cannot block the source indefinitely.
 */
export function sessionlessRunStaleMinutes(): number {
  return boundedMinutes(
    process.env.AGENT_RUN_STALE_MINUTES,
    DEFAULT_SESSIONLESS_STALE_MINUTES,
    6,
    120,
  );
}

/**
 * Managed-agent sessions routinely outlive one serverless invocation. Keep a
 * persisted session resumable long enough for continuation polling, while
 * retaining an absolute bound for agents that never terminate.
 */
export function agentSessionMaxMinutes(): number {
  return boundedMinutes(
    process.env.AGENT_SESSION_MAX_MINUTES,
    DEFAULT_SESSION_MAX_MINUTES,
    15,
    120,
  );
}
