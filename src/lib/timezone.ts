/**
 * Format a Unix timestamp (seconds) or ISO 8601 string to a human-readable string
 * in the viewer's LOCAL timezone — auto-detected by the browser.
 */

function toDate(value: number | string): Date {
  if (typeof value === 'string') return new Date(value);
  return new Date(value * 1000);
}

export function formatDateTime(unixSeconds: number | string, opts?: {
  includeYear?: boolean;
  timeOnly?: boolean;
  dateOnly?: boolean;
  short?: boolean;
}): string {
  if (!unixSeconds) return '—';
  const date = toDate(unixSeconds);

  if (opts?.timeOnly) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  if (opts?.dateOnly) {
    return date.toLocaleDateString([], {
      weekday: opts?.short ? undefined : 'long',
      month: opts?.short ? 'short' : 'long',
      day: 'numeric',
      year: opts?.includeYear !== false ? 'numeric' : undefined,
    });
  }

  if (opts?.short) {
    return date.toLocaleString([], {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  return date.toLocaleString([], {
    weekday: 'long', month: 'long', day: 'numeric',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function formatSessionRange(startTime: number | string, endTime: number | string): string {
  if (!startTime) return '—';
  const start = toDate(startTime);
  const end   = toDate(endTime);
  const sameDay = start.toDateString() === end.toDateString();

  const date = start.toLocaleDateString([], {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const startTime_ = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endTime_   = end.toLocaleTimeString([],   { hour: '2-digit', minute: '2-digit' });

  // Also show timezone abbreviation
  const tz = start.toLocaleTimeString([], { timeZoneName: 'short' }).split(' ').pop() || '';

  if (sameDay) {
    return `${date} · ${startTime_} – ${endTime_} ${tz}`;
  }
  return `${date} ${startTime_} – ${end.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${endTime_} ${tz}`;
}

export function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);

  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7)   return `${days}d ago`;
  return new Date(isoString).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function getTimezoneLabel(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
