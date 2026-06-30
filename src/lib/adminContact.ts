import pool from './db';

let cachedDbEmail: string | null | undefined;

/**
 * The contact email to stamp on every event. It is ALWAYS the admin's email:
 *   1. ADMIN_EMAIL env var, if set; otherwise
 *   2. the first active admin user's email; otherwise
 *   3. null (callers fall back to whatever the agent provided).
 *
 * The env value is read every call (cheap); the DB fallback is memoized per
 * process — admin contact rarely changes, restart to refresh.
 */
export async function getAdminContact(): Promise<string | null> {
  const envEmail = process.env.ADMIN_EMAIL?.trim();
  if (envEmail) return envEmail;

  if (cachedDbEmail !== undefined) return cachedDbEmail;
  try {
    const [[row]] = await pool.query(
      "SELECT email FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1"
    ) as any;
    cachedDbEmail = row?.email ?? null;
  } catch {
    cachedDbEmail = null;
  }
  return cachedDbEmail ?? null;
}
