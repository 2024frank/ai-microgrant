import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

function mediaSecret(): string {
  const secret = (
    process.env.MEDIA_PROXY_SECRET
    || process.env.CRON_SECRET
    || process.env.INGEST_SECRET
    || ''
  ).trim();
  if (secret.length < 16) {
    throw new Error('MEDIA_PROXY_SECRET must be configured with at least 16 characters');
  }
  return secret;
}

function equalToken(expected: string, candidate: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(candidate);
  return expectedBytes.byteLength === receivedBytes.byteLength
    && timingSafeEqual(expectedBytes, receivedBytes);
}

function legacyEventMediaToken(eventId: string | number): string {
  return createHmac('sha256', mediaSecret())
    .update(`event-media:v1:${eventId}`)
    .digest('base64url');
}

/**
 * CommunityHub needs a signed URL for a private draft poster. Bind the URL to
 * the media content so a later poster revision cannot reuse a cached URL.
 */
export function createEventMediaToken(eventId: string | number, mediaValue: string): string {
  const revision = createHash('sha256').update(mediaValue).digest('base64url').slice(0, 22);
  const signature = createHmac('sha256', mediaSecret())
    .update(`event-media:v2:${eventId}:${revision}`)
    .digest('base64url');
  return `v2.${revision}.${signature}`;
}

export function isValidEventMediaToken(
  eventId: string | number,
  candidate: string | null,
  currentMediaValue: string,
): boolean {
  if (!candidate) return false;
  try {
    // Preserve already-submitted v1 URLs while all newly issued URLs are
    // content-versioned v2 tokens.
    if (!candidate.startsWith('v2.')) {
      return equalToken(legacyEventMediaToken(eventId), candidate);
    }
    const match = /^v2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(candidate);
    if (!match) return false;
    // Do not trust the revision embedded in the request. Recompute the whole
    // token from the bytes/URL that this response is about to serve so an old
    // signed URL cannot authorize a later pending or rejected poster.
    return equalToken(createEventMediaToken(eventId, currentMediaValue), candidate);
  } catch {
    return false;
  }
}
