import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

function equalSecret(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Accept Vercel's bearer cron header or the internal POST header. */
export function isCronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const bearer = req.headers.get('authorization');
  if (equalSecret(bearer, `Bearer ${expected}`)) return true;
  return equalSecret(req.headers.get('x-cron-secret'), expected);
}

export function cronUnavailable(): boolean {
  return !process.env.CRON_SECRET?.trim();
}
