'use client';

import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDownUp,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Filter,
  Inbox,
  RefreshCcw,
  SearchX,
  SlidersHorizontal,
  X,
  XCircle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import EventTypeBadge from '@/components/EventTypeBadge';
import { useAuth } from '@/hooks/useAuth';
import { formatDateTime } from '@/lib/timezone';

const SORT_OPTIONS = [
  { value: 'ingested_asc', label: 'Oldest received first' },
  { value: 'ingested_desc', label: 'Newest received first' },
  { value: 'event_date_asc', label: 'Earliest post date first' },
  { value: 'event_date_desc', label: 'Latest post date first' },
];

const REASON_CODES = [
  { code: 'wrong_audience', label: 'Wrong audience' },
  { code: 'bad_date_parse', label: 'Bad date or time' },
  { code: 'duplicate_missed', label: 'Duplicate' },
  { code: 'description_hallucinated', label: 'Invented description details' },
  { code: 'missing_fields', label: 'Missing required fields' },
  { code: 'wrong_geo_scope', label: 'Wrong geographic scope' },
  { code: 'not_public_event', label: 'Not public' },
  { code: 'wrong_post_type', label: 'Wrong post kind or category' },
  { code: 'bad_location', label: 'Bad location' },
  { code: 'other', label: 'Other' },
];

const GEO_LABELS: Record<string, string> = {
  hyper_local: 'Hyper-local',
  city_wide: 'City-wide',
  county: 'County',
  regional: 'Regional',
};

interface QueueEvent {
  id: number;
  title: string;
  event_type: string;
  sessions: unknown;
  geo_scope?: string | null;
  created_at: string;
  source_name: string;
  source_slug?: string;
  sent_for_correction?: boolean | number;
  corrected_from_id?: number | null;
  sent_for_fix_by?: string | null;
  validation_errors?: unknown;
}

interface SourceOption {
  id: number;
  name: string;
}

function QueueLoadingFallback() {
  return <div className="loading-state" role="status"><span className="spinner" /> Preparing review queue…</div>;
}

export default function ReviewerQueuePage() {
  return (
    <Suspense fallback={<QueueLoadingFallback />}>
      <ReviewerQueueContent />
    </Suspense>
  );
}

function ReviewerQueueContent() {
  const { user, token, ready } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const querySourceId = searchParams.get('source_id') || '';
  const querySort = SORT_OPTIONS.some(option => option.value === searchParams.get('sort'))
    ? String(searchParams.get('sort'))
    : 'ingested_asc';
  const [events, setEvents] = useState<QueueEvent[]>([]);
  const [sources, setSources] = useState<SourceOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState(querySort);
  const [sourceId, setSourceId] = useState(querySourceId);
  const [newRecordsAvailable, setNewRecordsAvailable] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkRejectOpen, setBulkRejectOpen] = useState(false);
  const [bulkReasons, setBulkReasons] = useState<string[]>(['other']);
  const [bulkNote, setBulkNote] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkResult, setBulkResult] = useState('');
  const lastTotalRef = useRef<number | null>(null);

  useEffect(() => {
    setSourceId(querySourceId);
    setSort(querySort);
    setPage(0);
  }, [querySourceId, querySort]);

  const loadQueue = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({
      page: String(page),
      limit: '20',
      sort,
    });
    if (sourceId) query.set('source_id', sourceId);

    try {
      const response = await fetch(`/api/review/queue?${query.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error('The review queue could not be loaded.');
      const payload = await response.json();
      setEvents(Array.isArray(payload.events) ? payload.events : []);
      setSources(Array.isArray(payload.sources) ? payload.sources : []);
      setTotal(Number(payload.total) || 0);
      setSelected(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'The review queue could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [page, sort, sourceId, token]);

  useEffect(() => {
    if (!ready || !token) return;
    loadQueue();
  }, [ready, token, loadQueue]);

  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;
    const checkForNewRecords = async () => {
      try {
        const response = await fetch('/api/review/queue?limit=1', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return;
        const payload = await response.json();
        const nextTotal = Number(payload.total) || 0;
        if (!cancelled && lastTotalRef.current !== null && nextTotal > lastTotalRef.current) {
          setNewRecordsAvailable(true);
        }
        lastTotalRef.current = nextTotal;
      } catch {}
    };
    checkForNewRecords();
    const interval = window.setInterval(checkForNewRecords, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [ready, token]);

  useEffect(() => {
    if (!bulkRejectOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setBulkRejectOpen(false);
      setBulkReasons(['other']);
      setBulkNote('');
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [bulkRejectOpen]);

  if (!ready || !user) return null;

  const allSelected = events.length > 0 && events.every(event => selected.has(event.id));
  const selectedCount = selected.size;
  const selectedSourceName = sources.find(source => String(source.id) === sourceId)?.name;

  function updateFilters(nextSourceId: string, nextSort = sort) {
    setSourceId(nextSourceId);
    setSort(nextSort);
    setPage(0);
    const query = new URLSearchParams();
    if (nextSourceId) query.set('source_id', nextSourceId);
    if (nextSort !== 'ingested_asc') query.set('sort', nextSort);
    router.replace(`/reviewer/queue${query.size ? `?${query.toString()}` : ''}`, { scroll: false });
  }

  function toggleSelected(id: number) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(events.map(event => event.id)));
  }

  function resetRejectDialog() {
    setBulkRejectOpen(false);
    setBulkReasons(['other']);
    setBulkNote('');
  }

  async function bulkReject() {
    if (!token || !selectedCount || !bulkReasons.length) return;
    setBulkProcessing(true);
    const ids = [...selected];
    const results = await Promise.all(ids.map(async id => {
      try {
        const response = await fetch(`/api/review/events/${id}/action`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            action: 'reject',
            edits: { reason_codes: bulkReasons, reviewer_note: bulkNote },
            time_spent_sec: 0,
          }),
        });
        return response.ok;
      } catch {
        return false;
      }
    }));
    const succeeded = results.filter(Boolean).length;
    setBulkResult(`${succeeded} rejected${succeeded !== ids.length ? `; ${ids.length - succeeded} failed` : ''}.`);
    setBulkProcessing(false);
    resetRejectDialog();
    loadQueue();
  }

  function formatPostDate(sessions: unknown) {
    try {
      const parsed = typeof sessions === 'string' ? JSON.parse(sessions) : sessions;
      const start = Array.isArray(parsed) ? parsed[0]?.startTime : null;
      return start ? formatDateTime(start, { short: true, dateOnly: true }) : 'No date';
    } catch {
      return 'Invalid date';
    }
  }

  function validationIssueCount(value: unknown) {
    if (Array.isArray(value)) return value.length;
    if (typeof value !== 'string' || !value) return 0;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      return 1;
    }
  }

  return (
    <AppShell role={user.role} name={user.name} email={user.email} token={token} workspaceLabel="Reviewer workspace">
      <div className="sr-only" aria-live="polite">
        {bulkResult || (newRecordsAvailable ? 'New records are available.' : '')}
      </div>

      <main className="page-main">
        <header className="page-header">
          <div>
            <div className="page-header__eyebrow">Human review required</div>
            <h1>Review queue</h1>
            <p>{total} {total === 1 ? 'record is' : 'records are'} waiting. Open each record to compare source context, correct fields, and validate the CommunityHub payload.</p>
          </div>
          <div className="page-header__actions">
            <button type="button" className="btn-secondary" onClick={loadQueue} disabled={loading}>
              <RefreshCcw size={15} aria-hidden="true" /> Refresh
            </button>
          </div>
        </header>

        {newRecordsAvailable && (
          <button
            type="button"
            className="alert alert--success"
            style={{ width: '100%', marginBottom: 14, cursor: 'pointer', textAlign: 'left' }}
            onClick={() => {
              setNewRecordsAvailable(false);
              lastTotalRef.current = null;
              loadQueue();
            }}
          >
            <Inbox size={17} aria-hidden="true" />
            <span><strong>New records arrived.</strong> Refresh the queue to include them.</span>
          </button>
        )}

        <section className="filter-bar" aria-label="Queue filters">
          <div className="field">
            <label className="field__label" htmlFor="queue-source"><Filter size={12} aria-hidden="true" /> Source</label>
            <select
              id="queue-source"
              className="input"
              value={sourceId}
              onChange={event => updateFilters(event.target.value)}
            >
              <option value="">All available sources</option>
              {sources.map(source => <option key={source.id} value={String(source.id)}>{source.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="queue-sort"><ArrowDownUp size={12} aria-hidden="true" /> Sort</label>
            <select
              id="queue-sort"
              className="input"
              value={sort}
              onChange={event => updateFilters(sourceId, event.target.value)}
            >
              {SORT_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="filter-bar__spacer" />
          {sourceId && (
            <button type="button" className="btn-ghost" onClick={() => updateFilters('')}>
              <X size={14} aria-hidden="true" /> Clear {selectedSourceName || 'source'}
            </button>
          )}
        </section>

        {selectedCount > 0 && (
          <div className="selection-bar" role="region" aria-label="Bulk actions">
            <span className="selection-bar__count">{selectedCount} selected</span>
            <button type="button" className="btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
            <span style={{ flex: 1 }} />
            <span style={{ color: '#bcd0c7', fontSize: 11 }}>Publishing requires individual payload validation.</span>
            <button type="button" className="btn-danger" onClick={() => setBulkRejectOpen(true)}>
              <XCircle size={14} aria-hidden="true" /> Reject selected
            </button>
          </div>
        )}

        {bulkResult && (
          <div className="alert alert--info" style={{ marginBottom: 12 }}>
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{bulkResult}</span>
            <button type="button" className="icon-btn" style={{ marginLeft: 'auto', minHeight: 30, width: 30 }} aria-label="Dismiss result" onClick={() => setBulkResult('')}><X size={13} /></button>
          </div>
        )}

        {error ? (
          <div className="alert alert--error" role="alert"><XCircle size={17} aria-hidden="true" /> {error}</div>
        ) : loading ? (
          <div className="loading-state" role="status"><span className="spinner" /> Loading review records…</div>
        ) : events.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon"><SearchX size={23} aria-hidden="true" /></span>
            <h2>{sourceId ? 'No records match this source' : 'The review queue is clear'}</h2>
            <p>{sourceId ? 'Clear the source filter to return to the full queue.' : 'New records appear after an enabled source completes a run.'}</p>
            {sourceId && <button type="button" className="btn-secondary" style={{ marginTop: 16 }} onClick={() => updateFilters('')}>Clear filter</button>}
          </div>
        ) : (
          <section className="queue-list" aria-label="Records awaiting review">
            <label className="queue-select-all">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              <span>{allSelected ? 'Deselect this page' : 'Select this page'}</span>
            </label>

            {events.map(event => {
              const selectedEvent = selected.has(event.id);
              const awaitingCorrection = Boolean(event.sent_for_correction);
              const corrected = Boolean(event.corrected_from_id);
              const validationIssues = validationIssueCount(event.validation_errors);
              return (
                <article key={event.id} className="queue-item" data-selected={selectedEvent}>
                  <label className="queue-item__check" aria-label={`Select ${event.title}`}>
                    <input type="checkbox" checked={selectedEvent} onChange={() => toggleSelected(event.id)} />
                  </label>
                  <div className="queue-item__source-mark" aria-hidden="true">
                    {awaitingCorrection ? <RefreshCcw size={16} /> : event.source_name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="queue-item__content">
                    <div className="queue-item__title-row">
                      <Link className="queue-item__title" href={`/reviewer/events/${event.id}`}>{event.title || 'Untitled record'}</Link>
                      <EventTypeBadge value={event.event_type} />
                      {event.geo_scope && <span className="badge badge-blue">{GEO_LABELS[event.geo_scope] || event.geo_scope}</span>}
                      {awaitingCorrection && <span className="badge badge-amber">Correction queued</span>}
                      {corrected && <span className="badge badge-green">Returned correction</span>}
                      {validationIssues > 0 && <span className="badge badge-red">{validationIssues} contract issue{validationIssues === 1 ? '' : 's'}</span>}
                    </div>
                    <div className="queue-item__meta">
                      <span><SlidersHorizontal size={12} aria-hidden="true" /> {event.source_name}</span>
                      <span><CalendarDays size={12} aria-hidden="true" /> {formatPostDate(event.sessions)}</span>
                      <span><Clock3 size={12} aria-hidden="true" /> Received {new Date(event.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <ArrowRight className="queue-item__arrow" size={16} color="var(--ink-400)" aria-hidden="true" />
                </article>
              );
            })}
          </section>
        )}

        {total > 20 && (
          <nav className="pagination" aria-label="Queue pagination">
            <button type="button" className="btn-secondary" onClick={() => setPage(current => Math.max(0, current - 1))} disabled={page === 0}>Previous</button>
            <span className="badge badge-gray tnum">Page {page + 1} of {Math.ceil(total / 20)}</span>
            <button type="button" className="btn-secondary" onClick={() => setPage(current => current + 1)} disabled={(page + 1) * 20 >= total}>Next</button>
          </nav>
        )}
      </main>

      {bulkRejectOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) resetRejectDialog();
        }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-reject-title">
            <div className="dialog__header">
              <div>
                <h2 id="bulk-reject-title">Reject {selectedCount} {selectedCount === 1 ? 'record' : 'records'}</h2>
                <p>The same structured reasons and note will be stored for every selected record.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close rejection dialog" onClick={resetRejectDialog}><X size={16} /></button>
            </div>
            <div className="dialog__body">
              <fieldset className="fieldset">
                <legend className="fieldset__legend">Reasons</legend>
                <div className="segmented">
                  {REASON_CODES.map(reason => {
                    const active = bulkReasons.includes(reason.code);
                    return (
                      <button
                        type="button"
                        className="segment"
                        aria-pressed={active}
                        key={reason.code}
                        onClick={() => setBulkReasons(current => active ? current.filter(code => code !== reason.code) : [...current, reason.code])}
                      >
                        {reason.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <div className="field">
                <label className="field__label" htmlFor="bulk-reject-note">Reviewer note</label>
                <textarea id="bulk-reject-note" className="input" rows={3} value={bulkNote} onChange={event => setBulkNote(event.target.value)} placeholder="Optional context for future reviewers and extraction runs" autoFocus />
                <span className="field__hint">This is reviewer-feedback context, not model training.</span>
              </div>
            </div>
            <div className="dialog__actions">
              <button type="button" className="btn-secondary" onClick={resetRejectDialog}>Cancel</button>
              <button type="button" className="btn-danger" onClick={bulkReject} disabled={!bulkReasons.length || bulkProcessing}>
                {bulkProcessing ? <><span className="spinner" /> Rejecting…</> : <>Reject selected <XCircle size={14} /></>}
              </button>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}
