import { NextRequest } from 'next/server';
import { adminAuth } from './firebase-admin';
import pool from './db';

export interface AuthUser {
  id: number;
  uid: string;
  email: string;
  role: 'admin' | 'reviewer';
  name: string;
  canReviewAllSources: boolean;
}

export type AuthenticationResult =
  | { ok: true; user: AuthUser }
  | { ok: false; reason: 'missing_token' | 'invalid_token' | 'not_authorized' };

type UserRow = {
  id: number;
  firebase_uid: string | null;
  email: string;
  full_name: string;
  role: 'admin' | 'reviewer';
  can_review_all_sources?: number | boolean | string;
};

function enabled(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function isDuplicateEntry(error: unknown): boolean {
  const candidate = error as { code?: unknown; errno?: unknown } | null;
  return candidate?.code === 'ER_DUP_ENTRY' || candidate?.errno === 1062;
}

const TOKEN_VERIFICATION_CODES = new Set([
  'auth/argument-error',
  'auth/invalid-argument',
  'auth/id-token-expired',
  'auth/id-token-revoked',
  'auth/invalid-id-token',
  'auth/user-disabled',
  'auth/user-not-found',
]);

function isTokenVerificationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TOKEN_VERIFICATION_CODES.has(code);
}

function toAuthUser(row: UserRow, uid: string): AuthUser {
  return {
    id: Number(row.id),
    uid,
    email: row.email,
    role: row.role,
    name: row.full_name,
    canReviewAllSources: enabled(row.can_review_all_sources),
  };
}

/**
 * Verify a Firebase identity and resolve it to one pre-approved local account.
 *
 * UID is authoritative once bound. Email is used only for the first claim,
 * only when Firebase has verified it, and only while the invitation remains
 * unclaimed. The conditional UPDATE is the race-safe identity boundary.
 * Database/configuration failures intentionally propagate instead of being
 * mislabeled as an invalid user token.
 */
export async function authenticateRequest(req: NextRequest): Promise<AuthenticationResult> {
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ') || header.length <= 7) {
    return { ok: false, reason: 'missing_token' };
  }

  let decoded: Awaited<ReturnType<typeof adminAuth.verifyIdToken>>;
  try {
    // Check revocation so disabled Firebase accounts do not retain access until
    // their ID token naturally expires.
    decoded = await adminAuth.verifyIdToken(header.slice(7), true);
  } catch (error) {
    // Firebase token failures are client authentication errors. Service-account
    // parsing, SDK initialization, and upstream outages are server failures and
    // must propagate so /api/auth/me can return 503 instead of forcing logout.
    if (isTokenVerificationError(error)) {
      return { ok: false, reason: 'invalid_token' };
    }
    throw error;
  }

  const [[bound]] = await pool.query(
    `SELECT id, firebase_uid, email, full_name, role, can_review_all_sources
     FROM users WHERE firebase_uid=? AND active=1 LIMIT 1`,
    [decoded.uid],
  ) as any as [[UserRow | undefined]];
  if (bound) return { ok: true, user: toAuthUser(bound, decoded.uid) };

  const email = decoded.email?.trim().toLowerCase();
  if (!email || decoded.email_verified !== true) {
    return { ok: false, reason: 'not_authorized' };
  }

  try {
    await pool.query(
      `UPDATE users
       SET firebase_uid=?
       WHERE email=? AND active=1
         AND (firebase_uid IS NULL OR firebase_uid='')`,
      [decoded.uid, email],
    );
  } catch (error) {
    // The UID can already belong to an inactive/different account. Treat that
    // as a denied claim, while allowing genuine database failures to surface.
    if (!isDuplicateEntry(error)) throw error;
    return { ok: false, reason: 'not_authorized' };
  }

  // Re-read by UID rather than trusting affectedRows. This handles a
  // concurrent first sign-in by the same Firebase identity without permitting
  // a different identity to rebind the email row.
  const [[claimed]] = await pool.query(
    `SELECT id, firebase_uid, email, full_name, role, can_review_all_sources
     FROM users WHERE firebase_uid=? AND active=1 LIMIT 1`,
    [decoded.uid],
  ) as any as [[UserRow | undefined]];

  return claimed
    ? { ok: true, user: toAuthUser(claimed, decoded.uid) }
    : { ok: false, reason: 'not_authorized' };
}

export async function getAuthUser(req: NextRequest): Promise<AuthUser | null> {
  const result = await authenticateRequest(req);
  return result.ok ? result.user : null;
}

export function unauthorized() {
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export function forbidden() {
  return Response.json({ error: 'Forbidden' }, { status: 403 });
}
