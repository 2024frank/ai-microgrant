import { createHmac, timingSafeEqual } from 'crypto';

function signingSecret(): string | null {
  const secret = process.env.INGEST_SECRET?.trim();
  return secret || null;
}

export function createFixToken(rawEventId: string | number): string {
  const secret = signingSecret();
  if (!secret) throw new Error('INGEST_SECRET is required to create fix tokens');

  return createHmac('sha256', secret)
    .update(String(rawEventId))
    .digest('hex');
}

export function isValidFixToken(rawEventId: string | number, token: string | null): boolean {
  if (!token) return false;

  let expected: string;
  try {
    expected = createFixToken(rawEventId);
  } catch {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'hex');
  const tokenBuffer = Buffer.from(token, 'hex');
  return expectedBuffer.length === tokenBuffer.length && timingSafeEqual(expectedBuffer, tokenBuffer);
}
