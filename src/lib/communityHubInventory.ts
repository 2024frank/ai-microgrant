const INVENTORY_ENDPOINT = 'https://oberlin.communityhub.cloud/api/legacy/calendar/posts';
const INVENTORY_LIMIT = 10_000;
const MAX_INVENTORY_PAGES = 20;

export const COMMUNITY_HUB_INVENTORY_URL = `${INVENTORY_ENDPOINT}?limit=10000&page=0&filter=future&tab=main-feed&isJobs=false&order=ASC&postType=All&allPosts=`;

export const COMMUNITY_HUB_AGENT_DEDUP_INSTRUCTIONS = `Extract and return EVERY eligible event from the source, including events that may already exist on the CommunityHub calendar. Do not fetch the CommunityHub inventory and do not skip an event because you believe it is a duplicate — the platform compares every candidate against the complete approved-and-pending CommunityHub inventory server-side, records the comparison for human review, and preserves duplicates instead of publishing them twice. Send a distinct calendarSourceUrl per item (the specific event page when one exists) so the server-side comparison stays accurate.`;

export type ContentSession = {
  start: number;
  end: number;
};

export type ComparableEventContent = {
  title?: unknown;
  name?: unknown;
  eventType?: unknown;
  event_type?: unknown;
  description?: unknown;
  extendedDescription?: unknown;
  extended_description?: unknown;
  calendarSourceUrl?: unknown;
  calendar_source_url?: unknown;
  sessions?: unknown;
};

/**
 * Raw, human-readable values retained for attribution and field-level diffs in
 * run comparisons. The sibling normalized fields exist only for matching.
 */
export type CommunityHubInventoryPostRaw = {
  name: string;
  description: string;
  extendedDescription: string;
  calendarSourceName: string;
  calendarSourceUrl: string;
  location: string;
  sponsors: string[];
  organizations: string[];
  ingestedPostUrl: string;
  hasImage: boolean;
};

export type CommunityHubInventoryPost = {
  title: string;
  eventType: string;
  description: string;
  extendedDescription: string;
  calendarSourceUrl: string;
  sessions: ContentSession[];
  timezone?: string;
  moderation: 'approved' | 'pending';
  raw?: CommunityHubInventoryPostRaw;
};

export type CommunityHubInventory = {
  posts: CommunityHubInventoryPost[];
  approved: number;
  pending: number;
  pages: number;
  reportedCount: number;
  reportedUnapprovedCount: number | null;
};

export type ContentMatch = {
  kind: 'exact' | 'probable' | 'none';
  reasons: string[];
  remote?: CommunityHubInventoryPost;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function normalizeComparableText(value: unknown): string {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeUrl(value: unknown): string {
  const candidate = text(value).trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}${url.search}`;
  } catch {
    return normalizeComparableText(candidate);
  }
}

function integer(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function normalizeContentSessions(value: unknown): ContentSession[] {
  if (typeof value === 'string') {
    try {
      return normalizeContentSessions(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const sessions = value.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const start = integer(record.startTime ?? record.start);
    const end = integer(record.endTime ?? record.end ?? record.startTime ?? record.start);
    if (start === null || end === null) return [];
    return [{ start, end }];
  });
  return [...new Map(
    sessions
      .sort((left, right) => left.start - right.start || left.end - right.end)
      .map(session => [`${session.start}:${session.end}`, session]),
  ).values()];
}

function normalizedContent(input: ComparableEventContent) {
  return {
    title: normalizeComparableText(input.title ?? input.name),
    eventType: normalizeComparableText(input.eventType ?? input.event_type),
    description: normalizeComparableText(input.description),
    extendedDescription: normalizeComparableText(
      input.extendedDescription ?? input.extended_description,
    ),
    calendarSourceUrl: normalizeUrl(
      input.calendarSourceUrl ?? input.calendar_source_url,
    ),
    sessions: normalizeContentSessions(input.sessions),
  };
}

function sessionKey(session: ContentSession): string {
  return `${session.start}:${session.end}`;
}

function setsEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftTokens = new Set(left.split(' ').filter(token => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter(token => token.length > 1));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function tokenCoverage(left: string, right: string): number {
  if (!left || !right) return 0;
  const leftTokens = new Set(left.split(' ').filter(token => token.length > 1));
  const rightTokens = new Set(right.split(' ').filter(token => token.length > 1));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function sessionDateKey(timestamp: number, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestamp * 1000));
  } catch {
    return new Date(timestamp * 1000).toISOString().slice(0, 10);
  }
}

function postCopyMentionsSessionDate(
  sessions: ContentSession[],
  remoteText: string,
  timezone: string,
): boolean {
  if (!remoteText) return false;
  return sessions.some(session => {
    let parts: Intl.DateTimeFormatPart[];
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        month: 'long',
        day: 'numeric',
      }).formatToParts(new Date(session.start * 1000));
    } catch {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        month: 'long',
        day: 'numeric',
      }).formatToParts(new Date(session.start * 1000));
    }
    const month = parts.find(part => part.type === 'month')?.value.toLowerCase();
    const day = parts.find(part => part.type === 'day')?.value;
    if (!month || !day) return false;
    const shortMonth = month.slice(0, 3);
    const pattern = new RegExp(
      `\\b(?:${month}|${shortMonth})\\s+${day}(?:st|nd|rd|th)?\\b`,
    );
    return pattern.test(remoteText);
  });
}

export function compareEventContent(
  localInput: ComparableEventContent,
  remote: CommunityHubInventoryPost,
): ContentMatch {
  const local = normalizedContent(localInput);
  const remoteContent = normalizedContent(remote);
  const localWindows = local.sessions.map(sessionKey);
  const remoteWindows = remoteContent.sessions.map(sessionKey);
  const localStarts = new Set(local.sessions.map(session => session.start));
  const sharedStarts = remoteContent.sessions.filter(session => localStarts.has(session.start)).length;
  const exactWindows = localWindows.length > 0
    && remoteWindows.length > 0
    && setsEqual(localWindows, remoteWindows);
  const exactTitle = Boolean(local.title && local.title === remoteContent.title);
  const titleSimilarity = tokenSimilarity(local.title, remoteContent.title);
  const titleCoverage = tokenCoverage(local.title, remoteContent.title);
  const sameSourceUrl = Boolean(
    local.calendarSourceUrl
    && local.calendarSourceUrl === remoteContent.calendarSourceUrl,
  );
  const sameEventType = Boolean(local.eventType && local.eventType === remoteContent.eventType);
  const compatibleEventType = !local.eventType || !remoteContent.eventType || sameEventType;
  const exactDescription = Boolean(
    local.description
    && local.description === remoteContent.description,
  );
  const exactExtendedDescription = local.extendedDescription === remoteContent.extendedDescription;
  const isAnnouncement = local.eventType === 'an' || remoteContent.eventType === 'an';
  const descriptionTokenSimilarity = tokenSimilarity(
    local.description,
    remoteContent.description,
  );
  const extendedDescriptionSimilarity = tokenSimilarity(
    local.extendedDescription,
    remoteContent.extendedDescription,
  );
  const descriptionSimilarity = Math.max(
    descriptionTokenSimilarity,
    extendedDescriptionSimilarity,
  );
  const localCopy = `${local.description} ${local.extendedDescription}`.trim();
  const remoteCopy = `${remoteContent.description} ${remoteContent.extendedDescription}`.trim();
  const combinedCopyCoverage = tokenCoverage(localCopy, remoteCopy);
  const timezone = remote.timezone || 'America/New_York';
  const localDays = new Set(local.sessions.map(session => sessionDateKey(session.start, timezone)));
  const sharedSessionDays = remoteContent.sessions.filter(
    session => localDays.has(sessionDateKey(session.start, timezone)),
  ).length;
  const sessionDateInPostCopy = postCopyMentionsSessionDate(
    local.sessions,
    remoteCopy,
    timezone,
  );

  // Announcement titles are often generic (for example, "Coming Soon") and
  // can reuse one broad display window. Their actual copy is therefore part
  // of the identity, matching the ingestion deduplication contract.
  const exactAnnouncementCopy = exactDescription && exactExtendedDescription;
  if (
    exactTitle
    && exactWindows
    && compatibleEventType
    && (!isAnnouncement || exactAnnouncementCopy)
  ) {
    return {
      kind: 'exact',
      reasons: [
        'normalized title',
        'complete session windows',
        ...(sameEventType ? ['event type'] : []),
        ...(isAnnouncement ? ['announcement copy'] : []),
      ],
      remote,
    };
  }

  const probableAnnouncementCopy = descriptionTokenSimilarity >= 0.8
    && (
      !local.extendedDescription
      || !remoteContent.extendedDescription
      || extendedDescriptionSimilarity >= 0.7
    );
  const contentSupportsProbableMatch = !isAnnouncement || probableAnnouncementCopy;
  const strongTitle = exactTitle || titleSimilarity >= 0.72 || titleCoverage >= 0.85;
  const temporalEvidence = sharedStarts > 0
    || sharedSessionDays > 0
    || sessionDateInPostCopy;
  const strongTitleAndTime = temporalEvidence
    && strongTitle
    && (
      sameEventType
      || sameSourceUrl
      || descriptionSimilarity >= 0.45
      || combinedCopyCoverage >= 0.7
    )
    && contentSupportsProbableMatch;
  const editedSessionsButSameListing = exactTitle
    && sameSourceUrl
    && (sameEventType || descriptionSimilarity >= 0.55)
    && contentSupportsProbableMatch;
  const strongDescriptionAndTime = sharedStarts > 0
    && sameEventType
    && descriptionSimilarity >= 0.8
    && contentSupportsProbableMatch;

  if (strongTitleAndTime || editedSessionsButSameListing || strongDescriptionAndTime) {
    const reasons = [
      exactTitle ? 'normalized title' : titleSimilarity >= 0.72 ? 'similar title' : '',
      sharedStarts > 0 ? 'shared session start' : '',
      sharedStarts === 0 && sharedSessionDays > 0 ? 'shared session date' : '',
      sharedStarts === 0 && sharedSessionDays === 0 && sessionDateInPostCopy
        ? 'session date in post content'
        : '',
      !exactTitle && titleSimilarity < 0.72 && titleCoverage >= 0.85 ? 'title content' : '',
      sameSourceUrl ? 'source URL' : '',
      sameEventType ? 'event type' : '',
      descriptionSimilarity >= 0.45 || combinedCopyCoverage >= 0.7
        ? 'description content'
        : '',
    ].filter(Boolean);
    return { kind: 'probable', reasons, remote };
  }

  return { kind: 'none', reasons: [] };
}

export function findBestContentMatch(
  local: ComparableEventContent,
  posts: CommunityHubInventoryPost[],
): ContentMatch {
  let probable: ContentMatch | null = null;
  for (const remote of posts) {
    const result = compareEventContent(local, remote);
    if (result.kind === 'exact') return result;
    if (result.kind === 'probable' && probable === null) probable = result;
  }
  return probable ?? { kind: 'none', reasons: [] };
}

function nameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (typeof item === 'string') return item.trim();
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        return text((item as Record<string, unknown>).name).trim();
      }
      return '';
    })
    .filter(Boolean);
}

function rawLocation(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return [text(record.name).trim(), text(record.address).trim()].filter(Boolean).join(' · ');
  }
  return '';
}

function rawPostEvidence(post: Record<string, unknown>): CommunityHubInventoryPostRaw {
  return {
    name: text(post.name).trim(),
    description: text(post.description).trim(),
    extendedDescription: text(post.extendedDescription).trim(),
    calendarSourceName: text(post.calendarSourceName).trim(),
    calendarSourceUrl: text(post.calendarSourceUrl).trim(),
    location: rawLocation(post.location),
    sponsors: nameList(post.sponsors),
    organizations: nameList(post.organizations),
    ingestedPostUrl: text(post.ingestedPostUrl).trim(),
    hasImage: Boolean(text(post.image).trim() || text(post.galleryImage).trim()),
  };
}

function moderation(value: unknown): 'approved' | 'pending' | 'rejected' | null {
  if (value === true || value === 1 || value === '1') return 'approved';
  if (value === null) return 'pending';
  if (value === false || value === 0 || value === '0') return 'rejected';
  return null;
}

function inventoryUrl(page: number): URL {
  const url = new URL(INVENTORY_ENDPOINT);
  const query: Record<string, string> = {
    limit: String(INVENTORY_LIMIT),
    page: String(page),
    filter: 'future',
    tab: 'main-feed',
    isJobs: 'false',
    order: 'ASC',
    postType: 'All',
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  url.searchParams.append('allPosts', '');
  return url;
}

export async function fetchCommunityHubInventory(
  fetcher: typeof fetch = fetch,
): Promise<CommunityHubInventory> {
  const rawPosts: Record<string, unknown>[] = [];
  let page = 0;
  let reportedCount: number | null = null;
  let reportedUnapprovedCount: number | null = null;

  while (page < MAX_INVENTORY_PAGES) {
    const response = await fetcher(inventoryUrl(page), {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`CommunityHub inventory returned HTTP ${response.status}`);
    }
    const body = await response.json() as Record<string, unknown>;
    if (!Array.isArray(body.posts) || typeof body.lastPage !== 'boolean') {
      throw new Error('CommunityHub inventory response is incomplete');
    }
    if (page === 0) {
      reportedCount = integer(body.count);
      const unapproved = Number(body.unapprovedRecordsCount);
      reportedUnapprovedCount = Number.isSafeInteger(unapproved) && unapproved >= 0
        ? unapproved
        : null;
      if (reportedCount === null) {
        throw new Error('CommunityHub inventory did not report a valid total count');
      }
    }
    for (const item of body.posts) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('CommunityHub inventory contains a malformed post');
      }
      rawPosts.push(item as Record<string, unknown>);
    }
    if (body.lastPage) break;
    page++;
  }

  if (page >= MAX_INVENTORY_PAGES) {
    throw new Error('CommunityHub inventory pagination did not terminate');
  }
  if (reportedCount === null || rawPosts.length !== reportedCount) {
    throw new Error(
      `CommunityHub inventory was truncated: expected ${reportedCount ?? 'unknown'}, received ${rawPosts.length}`,
    );
  }

  const posts: CommunityHubInventoryPost[] = [];
  for (const raw of rawPosts) {
    const state = moderation(raw.approved);
    if (state === null) {
      throw new Error('CommunityHub inventory contains an unknown approval state');
    }
    if (state === 'rejected') continue;
    const content = normalizedContent(raw);
    if (!content.title || content.sessions.length === 0) {
      throw new Error('CommunityHub inventory contains a post without comparable content');
    }
    posts.push({
      ...content,
      timezone: text(raw.timezone).trim() || 'America/New_York',
      moderation: state,
      raw: rawPostEvidence(raw),
    });
  }

  return {
    posts,
    approved: posts.filter(post => post.moderation === 'approved').length,
    pending: posts.filter(post => post.moderation === 'pending').length,
    pages: page + 1,
    reportedCount,
    reportedUnapprovedCount,
  };
}
