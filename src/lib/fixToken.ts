import { createHmac, timingSafeEqual } from 'crypto';

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

function signingSecret(): string {
  const secret = process.env.FIX_INGEST_TOKEN_SECRET || process.env.INGEST_SECRET;
  if (!secret) throw new Error('Missing fix ingest token secret');
  return secret;
}

function signature(slug: string, eventId: number, expiresAtMs: number): string {
  return createHmac('sha256', signingSecret())
    .update(`${TOKEN_VERSION}:${slug}:${eventId}:${expiresAtMs}`)
    .digest('base64url');
}

function getTokenTtlMs(): number {
  const configured = Number(process.env.FIX_INGEST_TOKEN_TTL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
}

export function createFixIngestToken(slug: string, eventId: string | number): string {
  const numericEventId = Number(eventId);
  if (!Number.isInteger(numericEventId) || numericEventId <= 0) {
    throw new Error('Invalid fixed event id');
  }

  const expiresAtMs = Date.now() + getTokenTtlMs();
  return `${TOKEN_VERSION}.${numericEventId}.${expiresAtMs}.${signature(slug, numericEventId, expiresAtMs)}`;
}

export function getSingleFixedFromEventId(events: any[]): number | null {
  let fixedFromId: number | null = null;

  for (const event of events) {
    const raw = event?.fixedFromEventId;
    if (raw === undefined || raw === null || raw === '') return null;

    const numeric = Number(raw);
    if (!Number.isInteger(numeric) || numeric <= 0) return null;
    if (fixedFromId !== null && fixedFromId !== numeric) return null;

    fixedFromId = numeric;
  }

  return fixedFromId;
}

export function verifyFixIngestToken(token: string | null, slug: string, events: any[]): boolean {
  if (!token) return false;

  const fixedFromId = getSingleFixedFromEventId(events);
  if (!fixedFromId) return false;

  const [version, rawEventId, rawExpiresAtMs, tokenSignature] = token.split('.');
  if (version !== TOKEN_VERSION || !rawEventId || !rawExpiresAtMs || !tokenSignature) {
    return false;
  }

  const tokenEventId = Number(rawEventId);
  const expiresAtMs = Number(rawExpiresAtMs);
  if (
    !Number.isInteger(tokenEventId) ||
    tokenEventId !== fixedFromId ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs < Date.now()
  ) {
    return false;
  }

  let expected: string;
  try {
    expected = signature(slug, tokenEventId, expiresAtMs);
  } catch {
    return false;
  }
  const actualBuffer = Buffer.from(tokenSignature);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
