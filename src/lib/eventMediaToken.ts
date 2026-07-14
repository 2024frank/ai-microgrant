import { createHmac, timingSafeEqual } from 'node:crypto';

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

/** Short-lived publishing still needs CommunityHub to retrieve a private draft poster. */
export function createEventMediaToken(eventId: string | number): string {
  return createHmac('sha256', mediaSecret())
    .update(`event-media:v1:${eventId}`)
    .digest('base64url');
}

export function isValidEventMediaToken(eventId: string | number, candidate: string | null): boolean {
  if (!candidate) return false;
  try {
    const expected = Buffer.from(createEventMediaToken(eventId));
    const received = Buffer.from(candidate);
    return expected.byteLength === received.byteLength && timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
