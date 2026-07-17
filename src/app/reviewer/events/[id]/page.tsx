'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileJson2,
  ImageIcon,
  Mail,
  MapPin,
  Plus,
  RefreshCcw,
  Save,
  ShieldCheck,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import EventTypeBadge from '@/components/EventTypeBadge';
import { useAuth } from '@/hooks/useAuth';
import { getTimezoneLabel } from '@/lib/timezone';
import {
  COMMUNITY_HUB_DISPLAY_TYPES,
  COMMUNITY_HUB_LOCATION_TYPES,
  OBERLIN_POST_TYPE_IDS,
  OBERLIN_POST_TYPE_LABELS,
} from '@/lib/communityHubPayload';
import { EVENT_TYPES, type EventType } from '@/lib/eventTypes';
import { validatePublicHttpUrl } from '@/lib/publicHttpUrl';
import { REJECTION_REASONS } from '@/lib/rejectionReasons';

type PostKind = EventType;
type Session = { startTime: number; endTime: number };
type ActionButton = { title: string; link: string };

interface ReadinessCheck {
  id: string;
  label: string;
  detail: string;
  pass: boolean;
}

const POST_KIND_DESCRIPTIONS: Record<PostKind, string> = {
  ot: 'A scheduled public event',
  an: 'A time-bound public notice',
  jp: 'A public employment post',
};
const POST_KINDS = EVENT_TYPES.map(kind => ({
  ...kind,
  description: POST_KIND_DESCRIPTIONS[kind.value],
}));

const POST_CATEGORIES = OBERLIN_POST_TYPE_IDS.map(id => ({
  id,
  label: OBERLIN_POST_TYPE_LABELS[id],
}));
const DOCUMENTED_CATEGORY_IDS = new Set<number>(POST_CATEGORIES.map(category => category.id));

const LOCATION_LABELS = {
  ph2: 'In person',
  on: 'Online',
  bo: 'Hybrid',
  ne: 'No location',
} as const;
const LOCATION_OPTIONS = COMMUNITY_HUB_LOCATION_TYPES.map(value => ({
  value,
  label: LOCATION_LABELS[value],
}));

const DISPLAY_LABELS = {
  all: 'All public screens',
  ps: 'School screens',
  sps: 'School + public',
  ss: 'Specific screens',
} as const;
const DISPLAY_OPTIONS = COMMUNITY_HUB_DISPLAY_TYPES.map(value => ({
  value,
  label: DISPLAY_LABELS[value],
}));

const GEO_OPTIONS = [
  { value: 'hyper_local', label: 'Hyper-local' },
  { value: 'city_wide', label: 'City-wide' },
  { value: 'county', label: 'County' },
  { value: 'regional', label: 'Regional' },
];

const REASON_LABELS = Object.fromEntries(
  REJECTION_REASONS.map(reason => [reason.code, reason.label]),
) as Record<string, string>;

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}

function normalizeStringArray(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => typeof item === 'string' || typeof item === 'number')
    .map(item => String(item).trim())
    .filter(Boolean);
}

function normalizeNumberArray(value: unknown): number[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed
    .map(item => Number(item))
    .filter(item => Number.isInteger(item) && item > 0))]
    .sort((a, b) => a - b);
}

function normalizeSessions(value: unknown): Session[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => item !== null && typeof item === 'object')
    .map(item => {
      const session = item as Record<string, unknown>;
      return {
        startTime: Number(session.startTime) || 0,
        endTime: Number(session.endTime) || 0,
      };
    });
}

function normalizeButtons(value: unknown): ActionButton[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(item => item !== null && typeof item === 'object')
    .map(item => {
      const button = item as Record<string, unknown>;
      return {
        title: typeof button.title === 'string' ? button.title : '',
        link: typeof button.link === 'string' ? button.link : '',
      };
    });
}

function toDatetimeLocal(value: number | string): string {
  if (!value) return '';
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 10_000
    ? new Date(numeric * 1000)
    : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocal(value: string): number {
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0;
}

function validHttpUrl(value: string) {
  if (!value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function validPhone(value: string) {
  return /^(?=.*\d)\+?[0-9().\-\s]{7,30}$/.test(value);
}

export default function ReviewEventPage() {
  const { user, token, ready } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const reviewStartedAt = useRef(0);
  const [event, setEvent] = useState<Record<string, any> | null>(null);
  const [edits, setEdits] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [reviewNote, setReviewNote] = useState('');
  const [correctionNote, setCorrectionNote] = useState('');
  const [sponsorDraft, setSponsorDraft] = useState('');
  const [screenIdsDraft, setScreenIdsDraft] = useState('');
  const [reviewNowSeconds, setReviewNowSeconds] = useState(0);
  const [timezoneLabel] = useState(getTimezoneLabel);
  const [posterPreviewUrl, setPosterPreviewUrl] = useState('');
  const eventLoaded = event !== null;
  const eventHasImageData = Boolean(event?.has_image_data);
  const eventImageUrl = String(event?.image_cdn_url || '');
  const eventImageUpdatedAt = String(event?.updated_at || '');
  const imageEditPending = Object.hasOwn(edits, 'image_cdn_url');

  useEffect(() => {
    reviewStartedAt.current = Date.now();
    const refreshNow = () => setReviewNowSeconds(Math.floor(Date.now() / 1000));
    refreshNow();
    const timer = window.setInterval(refreshNow, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!rejectOpen && !correctionOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRejectOpen(false);
      setCorrectionOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [rejectOpen, correctionOpen]);

  useEffect(() => {
    if (!ready || !token || !params.id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    fetch(`/api/review/events/${params.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'This record could not be loaded.');
        return payload;
      })
      .then(payload => {
        if (!cancelled) {
          setEvent(payload);
          setScreenIdsDraft(normalizeNumberArray(payload.screen_ids).join(', '));
        }
      })
      .catch(error => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : 'This record could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [ready, token, params.id]);

  useEffect(() => {
    if (!token || !params.id || !eventLoaded) return;
    if (imageEditPending) {
      setPosterPreviewUrl('');
      return;
    }
    if (!eventHasImageData && !eventImageUrl) {
      setPosterPreviewUrl('');
      return;
    }
    const controller = new AbortController();
    let objectUrl = '';
    fetch(`/api/events/${params.id}/image`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error('Poster unavailable');
        return response.blob();
      })
      .then(blob => {
        objectUrl = URL.createObjectURL(blob);
        setPosterPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setPosterPreviewUrl('');
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [
    token,
    params.id,
    eventLoaded,
    eventHasImageData,
    eventImageUrl,
    eventImageUpdatedAt,
    imageEditPending,
  ]);

  function field<T = any>(key: string, fallback: T = '' as T): T {
    if (edits[key] !== undefined) return edits[key] as T;
    if (event?.[key] !== null && event?.[key] !== undefined) return event[key] as T;
    return fallback;
  }

  function setField(key: string, value: any) {
    setEdits(current => ({ ...current, [key]: value }));
  }

  function showToast(message: string, error = false) {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 4200);
  }

  const isRejectedRecord = event?.status === 'rejected';
  const isSubmittedRecord = event?.status === 'submitted';
  const isPublishedRecord = event?.status === 'approved';
  const isCorrectionInProgress = event?.status === 'pending_fix'
    || (isRejectedRecord && (event?.sent_for_correction === true || Number(event?.sent_for_correction) === 1));
  const isRejected = isRejectedRecord && !isCorrectionInProgress;
  const isReadOnly = event?.status !== 'pending';
  const postKind = String(field('event_type', ''));
  const title = String(field('title', ''));
  const description = String(field('description', ''));
  const extendedDescription = String(field('extended_description', ''));
  const locationType = String(field('location_type', ''));
  const location = String(field('location', ''));
  const placeId = String(field('place_id', ''));
  const urlLink = String(field('url_link', ''));
  const contactEmail = String(field('contact_email', ''));
  const phone = String(field('phone', ''));
  const website = String(field('website', ''));
  const imageUrl = String(field('image_cdn_url', ''));
  const display = String(field('display', ''));
  const sessions = normalizeSessions(field('sessions', []));
  const sponsors = normalizeStringArray(field('sponsors', []));
  const postTypeIds = normalizeNumberArray(field('post_type_ids', []));
  const screenIds = normalizeNumberArray(field('screen_ids', []));
  const buttons = normalizeButtons(field('buttons', []));
  const calendarSourceName = String(field('calendar_source_name', ''));
  const calendarSourceUrl = String(field('calendar_source_url', ''));
  const ingestedPostUrl = String(field('ingested_post_url', ''));
  const ingestionValidationIssues = parseJson<Array<{ path?: string; message?: string }>>(
    event?.validation_errors,
    [],
  );
  const rejectionReasonCodes = normalizeStringArray(event?.rejection_reason_codes);
  const rejectionReviewerNote = String(event?.rejection_reviewer_note ?? '').trim();
  const isPreservedDuplicate = event?.status === 'duplicate';
  const duplicateMatch = parseJson<{
    kind?: string;
    reasons?: string[];
    remote?: { name?: string; moderation?: string; submission_origin?: string };
    field_diffs?: Array<{ field: string; local: string; remote: string; equal: boolean }>;
  } | null>(event?.communityhub_match, null);
  const collectionOrigin = event?.source_type === 'email'
    ? 'Collected from the organization by email'
    : event?.source_kind === 'aggregator'
      ? 'Collected from an aggregator source'
      : 'Collected from the original organization';
  const unsupportedCategoryIds = postTypeIds.filter(id => !DOCUMENTED_CATEGORY_IDS.has(id));
  const usesPhysicalLocation = ['ph2', 'bo'].includes(locationType);
  const placeIdNeedsClear = Boolean(placeId) && (
    !usesPhysicalLocation
    || (
      edits.location !== undefined
      && String(edits.location).trim() !== String(event?.location || '').trim()
    )
  );

  const readiness: ReadinessCheck[] = (() => {
    const validSessions = sessions.length > 0 && sessions.every(session => (
      Number.isSafeInteger(Number(session.startTime)) && Number(session.startTime) > 0
      && Number(session.startTime) <= 9_999_999_999
      && Number.isSafeInteger(Number(session.endTime))
      && Number(session.endTime) <= 9_999_999_999
      && Number(session.endTime) >= Number(session.startTime)
    ));
    const hasCurrentSession = reviewNowSeconds > 0 && validSessions && sessions.some(session => (
      Number(session.endTime) >= reviewNowSeconds
    ));
    const physicalReady = !['ph2', 'bo'].includes(locationType) || location.trim().length > 0;
    const onlineReady = !['on', 'bo'].includes(locationType) || validHttpUrl(urlLink);
    const displayReady = ['all', 'ps', 'sps', 'ss'].includes(display) && (display !== 'ss' || screenIds.length > 0);
    const optionalContactsReady = (!contactEmail || validEmail(contactEmail))
      && (!website || validHttpUrl(website))
      && (!imageUrl || validatePublicHttpUrl(imageUrl).success)
      && (!phone || validPhone(phone));
    const sourceLinksReady = (!calendarSourceUrl || validHttpUrl(calendarSourceUrl))
      && (!ingestedPostUrl || validHttpUrl(ingestedPostUrl));
    const buttonsReady = buttons.every(button => button.title.trim().length > 0 && validHttpUrl(button.link));

    return [
      {
        id: 'kind',
        label: 'Post kind',
        detail: ['ot', 'an', 'jp'].includes(postKind) ? 'Event, announcement, or job selected.' : 'Select Event, Announcement, or Job.',
        pass: ['ot', 'an', 'jp'].includes(postKind),
      },
      {
        id: 'email',
        label: 'Publishing email',
        detail: event?.publishing_email_configured
          ? 'A valid publishing identity is configured on the server.'
          : 'An administrator must configure a valid CommunityHub publishing email.',
        pass: event?.publishing_email_configured === true,
      },
      {
        id: 'title',
        label: 'Title',
        detail: title.trim().length >= 1 && title.length <= 60 ? `${title.length}/60 characters.` : 'Required; 1–60 characters and not whitespace only.',
        pass: title.trim().length >= 1 && title.length <= 60,
      },
      {
        id: 'description',
        label: 'Description',
        detail: description.trim().length >= 10 && description.length <= 200 ? `${description.length}/200 characters.` : 'Required; 10–200 meaningful characters.',
        pass: description.trim().length >= 10 && description.length <= 200,
      },
      {
        id: 'sponsors',
        label: 'Sponsors',
        detail: sponsors.length ? `${sponsors.length} sponsor${sponsors.length === 1 ? '' : 's'} supplied.` : 'Add at least one sponsor.',
        pass: sponsors.length > 0,
      },
      {
        id: 'categories',
        label: 'Categories',
        // Name every selected category: a wrong-but-valid ID (e.g. 11 =
        // Spectator Sport) must be visible as words, not a bare number.
        detail: postTypeIds.length && !unsupportedCategoryIds.length
          ? `Publishing as: ${postTypeIds.map(id => (OBERLIN_POST_TYPE_LABELS as Record<number, string>)[id] ?? `Unknown ${id}`).join(', ')}.`
          : unsupportedCategoryIds.length ? `Unsupported category IDs: ${unsupportedCategoryIds.join(', ')}.` : 'Select at least one CommunityHub category.',
        pass: postTypeIds.length > 0 && unsupportedCategoryIds.length === 0,
      },
      {
        id: 'sessions',
        label: 'Sessions',
        detail: !validSessions
          ? 'Add a valid start and end time; end cannot precede start.'
          : hasCurrentSession
            ? `${sessions.length} valid session${sessions.length === 1 ? '' : 's'}; at least one is ongoing or upcoming.`
            : 'Every session has ended. Reject or correct this draft before publishing.',
        pass: validSessions && hasCurrentSession,
      },
      {
        id: 'location',
        label: 'Location',
        detail: physicalReady && onlineReady && LOCATION_OPTIONS.some(option => option.value === locationType)
          ? 'Conditional location fields are complete.'
          : 'Choose a location type and complete its required address or URL.',
        pass: physicalReady && onlineReady && LOCATION_OPTIONS.some(option => option.value === locationType),
      },
      {
        id: 'place-id',
        label: 'Place identity',
        detail: placeIdNeedsClear
          ? 'The stored place ID no longer matches the selected location. Clear it before publishing.'
          : 'The stored place identity is consistent with this draft.',
        pass: !placeIdNeedsClear,
      },
      {
        id: 'display',
        label: 'Display',
        detail: displayReady ? (display === 'ss' ? `${screenIds.length} specific screen${screenIds.length === 1 ? '' : 's'}.` : 'A valid screen audience is selected.') : 'Specific screens requires at least one existing screen ID.',
        pass: displayReady,
      },
      {
        id: 'optional',
        label: 'Links and contact fields',
        detail: optionalContactsReady && buttonsReady && extendedDescription.length <= 1000
          ? 'Optional values use valid formats.'
          : 'Correct invalid email, phone, URL, button, or long-description values.',
        pass: optionalContactsReady && sourceLinksReady && buttonsReady && extendedDescription.length <= 1000,
      },
      {
        id: 'ingestion-validation',
        label: 'Ingestion validation',
        detail: ingestionValidationIssues.length === 0
          ? 'The last server validation found no unresolved extractor issues.'
          : 'Save corrected fields to rerun server validation before publishing.',
        pass: ingestionValidationIssues.length === 0,
      },
    ];
  })();

  const failedChecks = readiness.filter(check => !check.pass);
  const payloadReady = failedChecks.length === 0;
  const hasEdits = Object.keys(edits).length > 0;

  const payloadPreview = (() => {
    const payload: Record<string, any> = {
      eventType: postKind || null,
      email: event?.publishing_email_configured ? '[server configured]' : '[missing server configuration]',
      subscribe: true,
      phone: phone || '',
      website: website || '',
      urlLink: urlLink || '',
      placeId: usesPhysicalLocation ? placeId : '',
      title,
      sponsors,
      postTypeId: postTypeIds,
      sessions,
      description,
      extendedDescription: extendedDescription || undefined,
      locationType: locationType || null,
      display: display || null,
      screensIds: display === 'ss' ? screenIds : [],
      calendarSourceName,
      calendarSourceUrl,
      ingestedPostUrl,
      public: '1',
    };
    if (contactEmail) payload.contactEmail = contactEmail;
    if (['ph2', 'bo'].includes(locationType)) payload.location = location;
    if (['on', 'bo'].includes(locationType)) payload.urlLink = urlLink;
    if (field('place_name', '')) payload.placeName = field('place_name');
    if (field('room_num', '')) payload.roomNum = field('room_num');
    payload.buttons = buttons;
    if (field('image_cdn_url', '') || event?.has_image_data) payload.image_cdn_url = '[application poster endpoint]';
    return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
  })();

  function updateSession(index: number, key: keyof Session, value: string) {
    setField('sessions', sessions.map((session, sessionIndex) => (
      sessionIndex === index ? { ...session, [key]: fromDatetimeLocal(value) } : session
    )));
  }

  function updateButton(index: number, key: keyof ActionButton, value: string) {
    setField('buttons', buttons.map((button, buttonIndex) => (
      buttonIndex === index ? { ...button, [key]: value } : button
    )));
  }

  function updateSponsor(index: number, value: string) {
    setField('sponsors', sponsors.map((sponsor, sponsorIndex) => (
      sponsorIndex === index ? value : sponsor
    )));
  }

  function addSponsor() {
    const nextSponsor = sponsorDraft.trim();
    if (!nextSponsor) return;
    setField('sponsors', [...sponsors, nextSponsor]);
    setSponsorDraft('');
  }

  async function saveEdits() {
    if (!token || !hasEdits) return;
    setSaving(true);
    try {
      const response = await fetch(`/api/events/${params.id}/edit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ edits }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Edits could not be saved.');
      setEvent(current => ({ ...current, ...payload.event }));
      setEdits({});
      const changed = Array.isArray(payload.changed_fields) ? payload.changed_fields.length : 0;
      showToast(`${changed || 'Field'} ${changed === 1 ? 'change' : 'changes'} saved as reviewer feedback.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Edits could not be saved.', true);
    } finally {
      setSaving(false);
    }
  }

  async function approve() {
    if (!token || !payloadReady || submitting || saving) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/review/events/${params.id}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'approve',
          edits,
          time_spent_sec: reviewStartedAt.current ? Math.round((Date.now() - reviewStartedAt.current) / 1000) : 0,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'CommunityHub did not accept this payload.');
      showToast('Submitted to CommunityHub and awaiting moderation.');
      window.dispatchEvent(new Event('review-queue-updated'));
      window.setTimeout(() => router.push('/reviewer/queue'), 900);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'This record could not be published.', true);
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!token || !reasons.length || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/review/events/${params.id}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          action: 'reject',
          edits: { reason_codes: reasons, reviewer_note: reviewNote },
          time_spent_sec: reviewStartedAt.current ? Math.round((Date.now() - reviewStartedAt.current) / 1000) : 0,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'This record could not be rejected.');
      showToast('Record rejected and reviewer feedback saved.');
      window.dispatchEvent(new Event('review-queue-updated'));
      window.setTimeout(() => router.push('/reviewer/queue'), 800);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'This record could not be rejected.', true);
      setSubmitting(false);
    }
  }

  async function requestCorrection() {
    if (!token || !correctionNote.trim() || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/review/events/${params.id}/send-for-correction`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ correction_notes: correctionNote.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The correction request could not be queued.');
      showToast(isRejected
        ? 'Correction started. A new draft will return to the review queue.'
        : 'Correction attempt queued for another review pass.');
      window.dispatchEvent(new Event('review-queue-updated'));
      window.setTimeout(() => router.push('/reviewer/queue'), 900);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The correction request could not be queued.', true);
      setSubmitting(false);
    }
  }

  if (!ready || !user) return null;

  return (
    <AppShell role={user.role} name={user.name} email={user.email} token={token} workspaceLabel="Payload review studio">
      <div aria-live="polite" aria-atomic="true">
        {toast && <div className={`toast ${toast.error ? 'toast--error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.message}</div>}
      </div>

      <main className="page-main">
        {loading ? (
          <div className="loading-state" role="status"><span className="spinner" /> Loading source and payload fields…</div>
        ) : loadError || !event ? (
          <div className="empty-state">
            <span className="empty-state__icon" style={{ background: 'var(--red-50)', color: 'var(--red-700)' }}><XCircle size={23} /></span>
            <h2>Record unavailable</h2>
            <p>{loadError || 'The requested record was not found.'}</p>
            <Link href="/reviewer/queue" className="btn-secondary" style={{ marginTop: 16 }}>Return to queue</Link>
          </div>
        ) : (
          <>
            <header className="studio-header">
              <div>
                <Link href={isRejectedRecord ? '/events/rejected' : '/reviewer/queue'} className="studio-back"><ArrowLeft size={14} /> {isRejectedRecord ? 'Back to rejected' : 'Back to queue'}</Link>
                <h1>Review Studio</h1>
                <p>{isRejected
                  ? 'Inspect the archived rejection and request a source-backed corrected draft for a new review pass.'
                  : isCorrectionInProgress
                    ? 'This original is locked while the correction workflow prepares a replacement draft.'
                    : 'Compare the extracted record, correct the draft, and inspect the exact outgoing payload before publishing.'}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <EventTypeBadge value={postKind} />
                <span className={isRejected ? 'badge badge-red' : isCorrectionInProgress ? 'badge badge-amber' : payloadReady ? 'badge badge-green' : 'badge badge-red'}>
                  {isRejected ? <XCircle size={12} /> : isCorrectionInProgress ? <RefreshCcw size={12} /> : payloadReady ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                  {isRejected ? 'Rejected archive' : isCorrectionInProgress ? 'Correction running' : payloadReady ? 'Ready to publish' : `${failedChecks.length} blocker${failedChecks.length === 1 ? '' : 's'}`}
                </span>
              </div>
            </header>

            {isPreservedDuplicate && (
              <section className="alert alert--warning" aria-label="Preserved duplicate details" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
                <AlertTriangle size={17} aria-hidden="true" />
                <div style={{ minWidth: 0 }}>
                  <strong>Preserved duplicate (not published)</strong>
                  <p style={{ margin: '6px 0 0' }}>
                    {duplicateMatch
                      ? `This imported candidate matched a ${duplicateMatch.remote?.submission_origin === 'direct_submission' ? 'direct calendar submission' : 'calendar post from this application'} (“${duplicateMatch.remote?.name || 'unknown post'}”, ${duplicateMatch.remote?.moderation || 'unknown'} on CommunityHub; ${duplicateMatch.kind || 'match'} match${duplicateMatch.reasons?.length ? ` on ${duplicateMatch.reasons.join(', ')}` : ''}).`
                      : 'This imported candidate duplicated an event already obtained from a more direct source.'}
                    {' '}It is preserved so the imported version can be compared with the version on the calendar.
                  </p>
                  {Boolean(duplicateMatch?.field_diffs?.length) && (
                    <details style={{ marginTop: 8 }}>
                      <summary>Field differences vs the calendar post</summary>
                      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
                        {duplicateMatch!.field_diffs!.filter(diff => !diff.equal).map(diff => (
                          <div key={diff.field} style={{ fontSize: 13 }}>
                            <strong>{diff.field}</strong><br />
                            imported: {diff.local || '(empty)'}<br />
                            calendar: {diff.remote || '(empty)'}
                          </div>
                        ))}
                        {duplicateMatch!.field_diffs!.every(diff => diff.equal) && (
                          <span>Every compared field matches the calendar post.</span>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </section>
            )}

            {isRejectedRecord && (
              <section className="alert alert--warning" aria-label="Latest rejection feedback" style={{ marginBottom: 16, alignItems: 'flex-start' }}>
                <XCircle size={17} aria-hidden="true" />
                <div>
                  <strong>Why this record was rejected</strong>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {rejectionReasonCodes.length > 0
                      ? rejectionReasonCodes.map(code => <span className="badge badge-red" key={code}>{REASON_LABELS[code] || code}</span>)
                      : <span>No structured reason was recorded.</span>}
                  </div>
                  {rejectionReviewerNote && <p style={{ margin: '8px 0 0' }}>{rejectionReviewerNote}</p>}
                </div>
              </section>
            )}

            <div className="studio-grid">
              <div>
                <form className="studio-form" onSubmit={event => event.preventDefault()}>
                  <fieldset className="studio-form__fieldset" disabled={isReadOnly} aria-label={isRejected ? 'Archived rejected payload' : isCorrectionInProgress ? 'Payload locked during correction' : isSubmittedRecord ? 'Payload awaiting CommunityHub moderation' : isPublishedRecord ? 'Published payload' : 'Editable review payload'}>
                  <StudioSection title="Post identity" hint="Post kind and categories are separate CommunityHub fields.">
                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">Post kind · eventType</legend>
                      <div className="segmented">
                        {POST_KINDS.map(kind => (
                          <button
                            type="button"
                            key={kind.value}
                            className="segment"
                            aria-pressed={postKind === kind.value}
                            title={kind.description}
                            onClick={() => setField('event_type', kind.value)}
                          >
                            {kind.label}
                          </button>
                        ))}
                      </div>
                      {!['ot', 'an', 'jp'].includes(postKind) && <div className="field__error" style={{ marginTop: 7 }}>The extracted code “{postKind || 'empty'}” is not a supported CommunityHub post kind. Choose one explicitly.</div>}
                    </fieldset>

                    <div className="field">
                      <label className="field__label" htmlFor="record-title">Title · {title.length}/60</label>
                      <input id="record-title" className="input" aria-invalid={title.trim().length < 1 || title.length > 60} maxLength={60} value={title} onChange={event => setField('title', event.target.value)} />
                      {(title.trim().length < 1 || title.length > 60) && <div className="field__error">A meaningful title between 1 and 60 characters is required.</div>}
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor="record-description">Short description · {description.length}/200</label>
                      <textarea id="record-description" className="input" aria-invalid={description.trim().length < 10 || description.length > 200} maxLength={200} rows={3} value={description} onChange={event => setField('description', event.target.value)} />
                      {(description.trim().length < 10 || description.length > 200) && <div className="field__error">The short description must contain 10–200 meaningful characters.</div>}
                    </div>

                    <div className="field">
                      <label className="field__label" htmlFor="record-extended-description">Long description · {extendedDescription.length}/1,000</label>
                      <textarea id="record-extended-description" className="input" aria-invalid={extendedDescription.length > 1000} maxLength={1000} rows={6} value={extendedDescription} onChange={event => setField('extended_description', event.target.value)} />
                    </div>

                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">Sponsors · minimum 1</legend>
                      <div className="studio-list-editor">
                        {sponsors.map((sponsor, index) => (
                          <div className="studio-list-editor__row" key={index}>
                            <label className="sr-only" htmlFor={`record-sponsor-${index}`}>Sponsor {index + 1}</label>
                            <input
                              id={`record-sponsor-${index}`}
                              className="input"
                              value={sponsor}
                              onChange={event => updateSponsor(index, event.target.value)}
                            />
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label={`Remove sponsor ${sponsor}`}
                              onClick={() => setField('sponsors', sponsors.filter((_, sponsorIndex) => sponsorIndex !== index))}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        ))}
                        <div className="studio-list-editor__row">
                          <label className="sr-only" htmlFor="record-sponsor-new">Add sponsor</label>
                          <input
                            id="record-sponsor-new"
                            className="input"
                            value={sponsorDraft}
                            onChange={event => setSponsorDraft(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                addSponsor();
                              }
                            }}
                            placeholder="Organization or host named by the source"
                          />
                          <button type="button" className="btn-secondary" onClick={addSponsor} disabled={!sponsorDraft.trim()}><Plus size={14} /> Add</button>
                        </div>
                      </div>
                      {!sponsors.length && <div className="field__error" style={{ marginTop: 8 }}>Add at least one sponsor stated by the source.</div>}
                      <span className="field__hint">Each sponsor is stored as a separate payload value; commas inside organization names are preserved.</span>
                    </fieldset>
                  </StudioSection>

                  <StudioSection title="Schedule" hint={`All times shown in ${timezoneLabel}.`}>
                    {sessions.map((session, index) => (
                      <div className="studio-session" key={index}>
                        <div className="field">
                          <label className="field__label" htmlFor={`session-${index}-start`}>Session {index + 1} start</label>
                          <input id={`session-${index}-start`} type="datetime-local" className="input" value={toDatetimeLocal(session.startTime)} onChange={event => updateSession(index, 'startTime', event.target.value)} />
                        </div>
                        <div className="field">
                          <label className="field__label" htmlFor={`session-${index}-end`}>End</label>
                          <input id={`session-${index}-end`} type="datetime-local" className="input" aria-invalid={!session.endTime || Number(session.endTime) < Number(session.startTime)} value={toDatetimeLocal(session.endTime)} onChange={event => updateSession(index, 'endTime', event.target.value)} />
                        </div>
                        <button type="button" className="icon-btn" aria-label={`Remove session ${index + 1}`} onClick={() => setField('sessions', sessions.filter((_, sessionIndex) => sessionIndex !== index))}><Trash2 size={15} /></button>
                      </div>
                    ))}
                    {!sessions.length && <div className="alert alert--error"><CalendarDays size={16} /> At least one valid session is required.</div>}
                    <button type="button" className="btn-secondary" style={{ width: 'fit-content' }} onClick={() => setField('sessions', [...sessions, { startTime: 0, endTime: 0 }])}><Plus size={14} /> Add session</button>
                  </StudioSection>

                  <StudioSection title="Location" hint="Required fields change with the selected location type.">
                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">Location type</legend>
                      <div className="segmented">
                        {LOCATION_OPTIONS.map(option => (
                          <button
                            type="button"
                            className="segment"
                            aria-pressed={locationType === option.value}
                            key={option.value}
                            onClick={() => {
                              setField('location_type', option.value);
                              if (!['ph2', 'bo'].includes(option.value) && placeId) setField('place_id', '');
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    {['ph2', 'bo'].includes(locationType) && (
                      <div className="field">
                        <label className="field__label" htmlFor="record-location">Street address · required</label>
                        <input id="record-location" className="input" aria-invalid={!location.trim()} value={location} onChange={event => setField('location', event.target.value)} placeholder="Street, city, state, ZIP" />
                      </div>
                    )}
                    {['on', 'bo'].includes(locationType) && (
                      <div className="field">
                        <label className="field__label" htmlFor="record-online-url">Online event URL · required</label>
                        <input id="record-online-url" className="input" type="url" aria-invalid={!validHttpUrl(urlLink)} value={urlLink} onChange={event => setField('url_link', event.target.value)} placeholder="https://…" />
                      </div>
                    )}
                    <div className="field-grid">
                      <div className="field">
                        <label className="field__label" htmlFor="record-place-name">Place name</label>
                        <input id="record-place-name" className="input" value={String(field('place_name', ''))} onChange={event => setField('place_name', event.target.value)} />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor="record-room">Room or space</label>
                        <input id="record-room" className="input" value={String(field('room_num', ''))} onChange={event => setField('room_num', event.target.value)} />
                      </div>
                    </div>
                    {placeId && (
                      <div className={placeIdNeedsClear ? 'alert alert--error' : 'alert alert--info'}>
                        {placeIdNeedsClear ? <AlertTriangle size={16} /> : <MapPin size={16} />}
                        <span>
                          <strong>Stored map place ID</strong><br />
                          {placeIdNeedsClear
                            ? 'The address or location type changed. Clear the stale place ID before publishing.'
                            : 'Keep this ID only while it still refers to the selected address.'}
                        </span>
                        <button type="button" className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setField('place_id', '')}>Clear place ID</button>
                      </div>
                    )}
                  </StudioSection>

                  <StudioSection title="Categories and distribution" hint="Categories are postTypeId values; they do not change the post kind.">
                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">CommunityHub categories · minimum 1</legend>
                      <div className="segmented">
                        {POST_CATEGORIES.map(category => {
                          const checked = postTypeIds.includes(category.id);
                          return (
                            <label className="chip-check" key={category.id}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={event => setField('post_type_ids', event.target.checked ? [...postTypeIds, category.id] : postTypeIds.filter(id => id !== category.id))}
                              />
                              <span>{category.label}</span>
                            </label>
                          );
                        })}
                      </div>
                      {!postTypeIds.length && <div className="field__error" style={{ marginTop: 8 }}>Select at least one category.</div>}
                      {unsupportedCategoryIds.length > 0 && (
                        <div className="alert alert--error" style={{ marginTop: 8 }}>
                          <AlertTriangle size={15} />
                          <span>Unsupported category IDs: {unsupportedCategoryIds.join(', ')}.</span>
                          <button type="button" className="btn-secondary" style={{ marginLeft: 'auto' }} onClick={() => setField('post_type_ids', postTypeIds.filter(id => DOCUMENTED_CATEGORY_IDS.has(id)))}>Remove</button>
                        </div>
                      )}
                    </fieldset>

                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">Screen distribution</legend>
                      <div className="segmented">
                        {DISPLAY_OPTIONS.map(option => (
                          <button type="button" className="segment" aria-pressed={display === option.value} key={option.value} onClick={() => setField('display', option.value)}>{option.label}</button>
                        ))}
                      </div>
                    </fieldset>
                    {display === 'ss' && (
                      <div className="field">
                        <label className="field__label" htmlFor="record-screen-ids">Specific screen IDs · minimum 1</label>
                        <input
                          id="record-screen-ids"
                          className="input tnum"
                          inputMode="numeric"
                          aria-invalid={!screenIds.length}
                          value={screenIdsDraft}
                          onChange={event => {
                            const draft = event.target.value;
                            setScreenIdsDraft(draft);
                            setField(
                              'screen_ids',
                              [...new Set(draft
                                .split(/[\s,]+/)
                                .map(value => Number(value))
                                .filter(value => Number.isSafeInteger(value) && value > 0))],
                            );
                          }}
                          onBlur={() => setScreenIdsDraft(screenIds.join(', '))}
                          placeholder="12, 18, 25"
                        />
                        <span className="field__hint">Enter existing CommunityHub screen IDs separated by commas.</span>
                        {!screenIds.length && <div className="field__error">Specific-screen distribution requires at least one screen ID.</div>}
                      </div>
                    )}

                    <fieldset className="fieldset">
                      <legend className="fieldset__legend">Internal geographic scope · not sent to CommunityHub</legend>
                      <div className="segmented">
                        {GEO_OPTIONS.map(option => (
                          <button type="button" className="segment" aria-pressed={field('geo_scope', '') === option.value} key={option.value} onClick={() => setField('geo_scope', option.value)}>{option.label}</button>
                        ))}
                      </div>
                    </fieldset>
                  </StudioSection>

                  <StudioSection title="Contact and media" hint="Optional values must be valid when supplied.">
                    <div className="alert alert--info"><Mail size={16} /> The required publishing email is supplied by the server. Contact email below is public event information.</div>
                    <div className="field-grid">
                      <div className="field">
                        <label className="field__label" htmlFor="record-contact-email">Contact email</label>
                        <input id="record-contact-email" className="input" type="email" aria-invalid={Boolean(contactEmail && !validEmail(contactEmail))} value={contactEmail} onChange={event => setField('contact_email', event.target.value)} />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor="record-phone">Phone</label>
                        <input id="record-phone" className="input" type="tel" aria-invalid={Boolean(phone && !validPhone(phone))} value={phone} onChange={event => setField('phone', event.target.value)} />
                      </div>
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="record-website">Website</label>
                      <input id="record-website" className="input" type="url" aria-invalid={Boolean(website && !validHttpUrl(website))} value={website} onChange={event => setField('website', event.target.value)} placeholder="https://…" />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="record-image">Image URL</label>
                        <input id="record-image" className="input" type="url" aria-invalid={Boolean(imageUrl && !validHttpUrl(imageUrl))} value={imageUrl} onChange={event => setField('image_cdn_url', event.target.value)} placeholder="https://…" />
                      <span className="field__hint">CommunityHub receives a stable application-served poster URL, not the third-party URL directly.</span>
                    </div>
                  </StudioSection>

                  <StudioSection title="Source attribution" hint="These values identify the public source behind the extracted record.">
                    <div className="field">
                      <label className="field__label" htmlFor="record-source-name">Calendar source name</label>
                      <input id="record-source-name" className="input" maxLength={120} value={calendarSourceName} onChange={event => setField('calendar_source_name', event.target.value)} placeholder="Publishing organization" />
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="record-source-url">Calendar source URL</label>
                      <input id="record-source-url" className="input" type="url" aria-invalid={Boolean(calendarSourceUrl && !validHttpUrl(calendarSourceUrl))} value={calendarSourceUrl} onChange={event => setField('calendar_source_url', event.target.value)} placeholder="https://…" />
                      <span className="field__hint">Use the exact event page when one exists, rather than a generic homepage.</span>
                    </div>
                    <div className="field">
                      <label className="field__label" htmlFor="record-ingested-url">Reviewer record URL · managed by this application</label>
                      <input id="record-ingested-url" className="input" type="url" value={ingestedPostUrl} readOnly />
                    </div>
                  </StudioSection>

                  <StudioSection title="Action buttons" hint="Every supplied button needs a label and a valid http(s) URL.">
                    {buttons.map((button, index) => (
                      <div className="studio-button-row" key={index}>
                        <div className="field">
                          <label className="field__label" htmlFor={`button-${index}-title`}>Button {index + 1} label</label>
                          <input id={`button-${index}-title`} className="input" aria-invalid={!button.title.trim()} value={button.title} onChange={event => updateButton(index, 'title', event.target.value)} placeholder="Learn more" />
                        </div>
                        <div className="field">
                          <label className="field__label" htmlFor={`button-${index}-link`}>URL</label>
                          <input id={`button-${index}-link`} className="input" type="url" aria-invalid={!validHttpUrl(button.link)} value={button.link} onChange={event => updateButton(index, 'link', event.target.value)} placeholder="https://…" />
                        </div>
                        <button type="button" className="icon-btn" aria-label={`Remove button ${index + 1}`} onClick={() => setField('buttons', buttons.filter((_, buttonIndex) => buttonIndex !== index))}><Trash2 size={15} /></button>
                      </div>
                    ))}
                    <button type="button" className="btn-secondary" style={{ width: 'fit-content' }} onClick={() => setField('buttons', [...buttons, { title: '', link: '' }])}><Plus size={14} /> Add button</button>
                  </StudioSection>
                  </fieldset>
                </form>

                <div className="studio-actions" aria-label="Review actions">
                  {isSubmittedRecord ? (
                    <div className="studio-actions__status">CommunityHub accepted this submission. It is not published until CommunityHub moderation approves it.</div>
                  ) : isPublishedRecord ? (
                    <div className="studio-actions__status">CommunityHub moderation approved this record. It is published.</div>
                  ) : isRejected ? (
                    <>
                      <div className="studio-actions__status">The rejected original stays in the audit trail. A successful correction creates a new pending draft that must be reviewed before publishing.</div>
                      <button type="button" className="btn-primary" onClick={() => setCorrectionOpen(true)} disabled={submitting}><RefreshCcw size={14} /> Request corrected draft</button>
                    </>
                  ) : isCorrectionInProgress ? (
                    <div className="studio-actions__status">Correction is in progress. This original is not part of the review queue; a new pending draft will appear when the correction succeeds.</div>
                  ) : isReadOnly ? (
                    <div className="studio-actions__status">This record is locked in its current workflow state. Refresh the queue or use the appropriate reconciliation workflow before taking another action.</div>
                  ) : (
                    <>
                      <div className="studio-actions__status">
                        {hasEdits
                          ? 'Draft fields changed. Save feedback before rejecting or requesting a correction; publishing can include the current draft directly.'
                          : payloadReady
                          ? 'All documented payload checks pass. Submission sends the record to CommunityHub for moderation.'
                          : `${failedChecks.length} documented requirement${failedChecks.length === 1 ? '' : 's'} must be fixed before publishing.`}
                      </div>
                      <button type="button" className="btn-secondary" onClick={saveEdits} disabled={!hasEdits || saving || submitting}><Save size={14} /> {saving ? 'Saving…' : 'Save feedback'}</button>
                      {event.source_slug !== 'fixed-events' && <button type="button" className="btn-warning" onClick={() => setCorrectionOpen(true)} disabled={submitting || hasEdits} title={hasEdits ? 'Save or revert draft edits first' : undefined}><RefreshCcw size={14} /> Request correction</button>}
                      <button type="button" className="btn-danger" onClick={() => setRejectOpen(true)} disabled={submitting || hasEdits} title={hasEdits ? 'Save or revert draft edits first' : undefined}><X size={14} /> Reject</button>
                      <button type="button" className="btn-primary" onClick={approve} disabled={!payloadReady || submitting || saving} title={!payloadReady ? 'Fix every readiness blocker before submitting' : undefined}><Check size={15} /> {submitting ? 'Submitting…' : 'Submit to CommunityHub'}</button>
                    </>
                  )}
                </div>
              </div>

              <aside className="studio-aside" aria-label="Source evidence and payload readiness">
                <section className="card source-evidence">
                  {posterPreviewUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- this is an authenticated same-origin blob URL.
                    <img className="source-evidence__image" src={posterPreviewUrl} alt="Extracted poster preview" />
                  ) : (
                    <div className="source-evidence__image" style={{ display: 'grid', placeItems: 'center', color: 'var(--ink-400)' }}><ImageIcon size={28} /><span className="sr-only">No poster image</span></div>
                  )}
                  <div className="card__header">
                    <div>
                      <h2 className="card__title">Source evidence</h2>
                      <p className="card__subtitle">Review the extraction against the original links before editing.</p>
                    </div>
                  </div>
                  <div className="source-evidence__meta">
                    <div><ShieldCheck size={14} aria-hidden="true" /><span><strong>{event.source_name}</strong><br />{collectionOrigin}<br />Received {new Date(event.created_at).toLocaleString()}</span></div>
                    {event.calendar_source_url && <div><ExternalLink size={14} /><a href={event.calendar_source_url} target="_blank" rel="noreferrer">Open calendar source</a></div>}
                    {event.ingested_post_url && <div><ExternalLink size={14} /><a href={event.ingested_post_url} target="_blank" rel="noreferrer">Open ingested post</a></div>}
                    {event.location && <div><MapPin size={14} /><span>{event.location}</span></div>}
                  </div>
                  <details className="payload-preview" style={{ marginTop: 16 }}>
                    <summary>Original extracted values</summary>
                    <pre>{JSON.stringify({
                      eventType: event.event_type,
                      title: event.title,
                      description: event.description,
                      sessions: parseJson(event.sessions, []),
                      sponsors: parseJson(event.sponsors, []),
                      postTypeId: normalizeNumberArray(event.post_type_ids)
                        .map(id => `${id} · ${(OBERLIN_POST_TYPE_LABELS as Record<number, string>)[id] ?? 'Unknown category'}`),
                    }, null, 2)}</pre>
                  </details>
                </section>

                <section className="card readiness-card">
                  <div className="readiness-score">
                    <div>
                      <div className="readiness-score__label">Payload readiness</div>
                      <div className="readiness-score__count">{readiness.length - failedChecks.length} of {readiness.length} checks pass</div>
                    </div>
                    <span className={payloadReady ? 'badge badge-green' : 'badge badge-red'}>{payloadReady ? 'Ready' : 'Blocked'}</span>
                  </div>
                  <div className="readiness-list">
                    {readiness.map(check => (
                      <div className="readiness-item" data-pass={check.pass} key={check.id}>
                        {check.pass ? <CheckCircle2 size={16} aria-hidden="true" /> : <XCircle size={16} aria-hidden="true" />}
                        <div><strong>{check.label}</strong><br />{check.detail}</div>
                      </div>
                    ))}
                  </div>
                  {ingestionValidationIssues.length > 0 && (
                    <div className="alert alert--error" style={{ marginTop: 14 }}>
                      <AlertTriangle size={16} aria-hidden="true" />
                      <span>
                        <strong>Ingestion flagged {ingestionValidationIssues.length} issue{ingestionValidationIssues.length === 1 ? '' : 's'}.</strong>{' '}
                        {ingestionValidationIssues.slice(0, 3).map(issue => `${issue.path || 'payload'}: ${issue.message || 'invalid value'}`).join(' · ')}
                      </span>
                    </div>
                  )}
                </section>

                <details className="card payload-preview">
                  <summary><FileJson2 size={14} style={{ verticalAlign: 'middle', marginRight: 6 }} />Outgoing payload preview</summary>
                  <pre>{JSON.stringify(payloadPreview, null, 2)}</pre>
                </details>
              </aside>
            </div>
          </>
        )}
      </main>

      {correctionOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setCorrectionOpen(false);
        }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="correction-title">
            <div className="dialog__header">
              <div>
                <h2 id="correction-title">{isRejected ? 'Request a corrected draft' : 'Request a correction attempt'}</h2>
                <p>{isRejected
                  ? 'The rejection reasons and your note are sent as untrusted correction context. The original remains archived and the returned draft must be reviewed again.'
                  : 'Your note is sent to the correction workflow. The returned record must be reviewed again.'}</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close correction dialog" onClick={() => setCorrectionOpen(false)}><X size={16} /></button>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="correction-note">Specific correction instructions</label>
              <textarea id="correction-note" className="input" rows={5} value={correctionNote} onChange={event => setCorrectionNote(event.target.value)} placeholder="State the incorrect field, the evidence, and the expected value." autoFocus />
              <span className="field__hint">This requests one automated correction attempt; it does not train or self-modify a model.</span>
            </div>
            <div className="dialog__actions">
              <button type="button" className="btn-secondary" onClick={() => setCorrectionOpen(false)}>Cancel</button>
              <button type="button" className={isRejected ? 'btn-primary' : 'btn-warning'} onClick={requestCorrection} disabled={!correctionNote.trim() || submitting}><RefreshCcw size={14} /> {isRejected ? 'Create corrected draft' : 'Queue correction'}</button>
            </div>
          </section>
        </div>
      )}

      {rejectOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setRejectOpen(false);
        }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title">
            <div className="dialog__header">
              <div>
                <h2 id="reject-title">Reject this record</h2>
                <p>Structured reasons and notes are retained as reviewer-feedback context for later extraction runs.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close rejection dialog" onClick={() => setRejectOpen(false)}><X size={16} /></button>
            </div>
            <div className="dialog__body">
              <fieldset className="fieldset">
                <legend className="fieldset__legend">Select every applicable reason</legend>
                <div style={{ display: 'grid', gap: 6 }}>
                  {REJECTION_REASONS.map(reason => (
                    <label className="list-row" style={{ minHeight: 42, cursor: 'pointer' }} key={reason.code}>
                      <input type="checkbox" checked={reasons.includes(reason.code)} onChange={event => setReasons(current => event.target.checked ? [...current, reason.code] : current.filter(code => code !== reason.code))} />
                      <span className="list-row__title">{reason.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="field">
                <label className="field__label" htmlFor="rejection-note">Reviewer note</label>
                <textarea id="rejection-note" className="input" rows={3} value={reviewNote} onChange={event => setReviewNote(event.target.value)} placeholder="Optional evidence or correction guidance" />
              </div>
              <div className="alert alert--info"><Circle size={15} /> Feedback can influence future prompt context, but it is not model retraining and does not guarantee a corrected result.</div>
            </div>
            <div className="dialog__actions">
              <button type="button" className="btn-secondary" onClick={() => setRejectOpen(false)}>Cancel</button>
              <button type="button" className="btn-danger" onClick={reject} disabled={!reasons.length || submitting}><XCircle size={14} /> Confirm rejection</button>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

function StudioSection({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="studio-section">
      <div className="studio-section__header">
        <h2 className="studio-section__title">{title}</h2>
        {hint && <span className="studio-section__hint">{hint}</span>}
      </div>
      <div className="studio-section__body">{children}</div>
    </section>
  );
}
