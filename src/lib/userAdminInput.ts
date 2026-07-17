export type ManagedRole = 'admin' | 'reviewer';

export type UserAccessInput = {
  role: ManagedRole;
  sourceIds: number[];
  canReviewAllSources: boolean;
};

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.replace(/\0/g, '').trim().toLowerCase();
  if (email.length < 3 || email.length > 150) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizeFullName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\0/g, '').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= 120 ? name : null;
}

export function normalizeRole(value: unknown, fallback?: ManagedRole): ManagedRole | null {
  const role = value === undefined ? fallback : value;
  return role === 'admin' || role === 'reviewer' ? role : null;
}

export function normalizeBoolean(value: unknown, fallback?: boolean): boolean | null {
  if (value === undefined) return fallback ?? null;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

export function normalizeSourceIds(value: unknown): number[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) return null;
  const ids = [...new Set(value.map(Number))];
  return ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids : null;
}

export function validateReviewerScope(input: UserAccessInput): string | null {
  if (input.role === 'admin') return null;
  if (input.canReviewAllSources && input.sourceIds.length > 0) {
    return 'Choose all sources or specific sources, not both';
  }
  if (!input.canReviewAllSources && input.sourceIds.length === 0) {
    return 'Reviewers require at least one source or explicit all-source access';
  }
  return null;
}
