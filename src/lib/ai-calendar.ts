export const PRODUCT_NAME = 'AI Calendar';

export type Role = 'platform_admin' | 'community_admin' | 'reviewer';
export type Me = { id: number; email: string; name: string | null; role: Role; communityId: number | null; canReviewAllSources: boolean };
export type Community = { id: number; slug: string; name: string; timezone: string; defaultMode: 'restricted' | 'unrestricted'; defaultDestinationId: number | null; status: 'active' | 'suspended' };
export type Destination = { id: number; communityId: number; name: string; type: 'ai_calendar' | 'communityhub' | 'webhook' | 'ical'; config: Record<string, unknown>; active: boolean };
export type Source = { id: number; communityId: number; name: string; slug: string; sourceType: 'web' | 'email'; sourceKind: 'original_org' | 'aggregator'; url: string | null; specialInstructions: string | null; mode: 'restricted' | 'unrestricted' | null; destinationId: number | null; discoveryStatus: 'pending' | 'discovering' | 'ready' | 'failed' | 'stale'; extractionRecipe: { extraction_method?: string; instruction_block?: string; notes?: string } | null; scheduleCron: string | null; active: boolean; orgName: string | null; orgWebsite: string | null };
export type EventItem = { id: number; communityId: number; sourceId: number | null; status: 'pending' | 'approved' | 'submitted' | 'rejected' | 'duplicate' | 'auto_rejected'; eventType: 'ot' | 'an' | 'jp' | null; title: string | null; description: string | null; extendedDescription: string | null; sessions: { startTime: number; endTime: number }[] | null; locationType: 'ph2' | 'on' | 'bo' | 'ne' | null; location: string | null; urlLink: string | null; postTypeIds: number[] | null; sponsors: string[] | null; imageCdnUrl: string | null; registrationUrl: string | null; provenance: 'direct' | 'original_org' | 'aggregator' | null; publishedVia: 'reviewer' | 'auto' | null; duplicateOfEventId: number | null; rejectionReason: string | null; createdAt: string };
export type Run = { id: number; communityId: number | null; sourceId: number | null; runKind: 'extraction' | 'discovery'; status: 'running' | 'completed' | 'failed' | 'stopped'; control: 'run' | 'pause' | 'stop'; phase: string | null; startedAt: string; finishedAt: string | null; budgetTotal: number | null; promptTokens: number; completionTokens: number; eventsFound: number; eventsExtracted: number; eventsDuplicate: number; eventsInvalid: number; eventsPublished: number };
export type RunEvent = { id: number; runId: number; seq: number; ts: string; kind: string; label: string | null; data: Record<string, unknown> | null };
export type UserRow = { id: number; email: string; name: string | null; role: Role; communityId: number | null; canReviewAllSources: boolean; status: 'active' | 'disabled' };

export const CATEGORIES: Record<number, string> = {
  1: 'Volunteer Opportunity', 2: 'Exhibit', 3: 'Fair/Festival', 4: 'Tour/Open House', 5: 'Film',
  6: 'Presentation/Lecture', 7: 'Workshop/Class', 8: 'Music Performance', 9: 'Theatre/Dance',
  10: 'City Government', 11: 'Spectator Sport', 12: 'Participatory Sport', 13: 'Networking',
  59: 'Ecolympics/Environmental', 89: 'Other',
};

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, body.error || `Request failed (${response.status})`);
  return body as T;
}

export function rows<T>(value: T[] | { items?: T[] } | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value?.items ?? [];
}

export function formatDate(value?: string | number | null, withTime = true) {
  if (value == null) return 'Not available';
  const date = typeof value === 'number' ? new Date(value < 10_000_000_000 ? value * 1000 : value) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not available';
  return new Intl.DateTimeFormat(undefined, withTime
    ? { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

export function elapsed(from: string, to?: string | null) {
  const seconds = Math.max(0, Math.round(((to ? new Date(to) : new Date()).getTime() - new Date(from).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function initials(me?: Pick<Me, 'name' | 'email'> | null) {
  const value = me?.name?.trim() || me?.email || 'User';
  return value.split(/\s+|@/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase()).join('');
}
