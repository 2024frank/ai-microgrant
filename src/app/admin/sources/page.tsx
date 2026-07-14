'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  FileText,
  LoaderCircle,
  Mail,
  PauseCircle,
  Pencil,
  Play,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Square,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { useAuth } from '@/hooks/useAuth';
import { describeCronExpression } from '@/lib/schedule';

const SCHEDULE_PRESETS = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Daily at 6:00 AM', value: '0 6 * * *' },
  { label: 'Weekdays at 6:00 AM', value: '0 6 * * 1-5' },
  { label: 'Mondays at 6:00 AM', value: '0 6 * * 1' },
];

interface SourceRecord {
  id: number;
  name: string;
  slug: string;
  agent_id?: string;
  source_type?: string;
  active: number | boolean;
  schedule_cron: string;
  total_events?: number;
  total_approved?: number;
  review_queue?: number;
  pending_review?: number;
  pending_fix?: number;
  total_rejected?: number;
  total_resubmitted?: number;
  total_publishing?: number;
  total_superseded?: number;
  validation_issues?: number;
  schedule_valid?: boolean;
  schedule_error?: string | null;
  schedule_timezone?: string;
  next_run_at?: string | null;
  health_status?:
    | 'disabled'
    | 'invalid_schedule'
    | 'no_run_history'
    | 'running'
    | 'last_run_completed'
    | 'last_run_failed'
    | 'last_run_stopped'
    | 'unknown_run_state';
  health_reason?: string;
  last_run_status?: string | null;
  last_run_at?: string | null;
  last_run_started_at?: string | null;
  last_error?: string | null;
  recent_runs?: Array<{
    id: number;
    status: string;
    started_at: string;
    finished_at?: string | null;
    events_found?: number;
    events_extracted?: number;
    events_skipped_dup?: number;
    events_errored?: number;
    elapsed_sec?: number;
    error_summary?: string | null;
  }>;
  fix_stats?: {
    pending_fix?: number;
    total_sent_for_fix?: number;
    total_fixed?: number;
    fixed_approved?: number;
  } | null;
}

interface RunRecord {
  id: number;
  source_id: number;
  source_name: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | string;
  started_at: string;
  finished_at?: string | null;
  events_found?: number;
  events_extracted?: number;
  events_skipped_dup?: number;
  events_errored?: number;
  error_log?: unknown;
  elapsed_sec?: number;
}

type Health = 'running' | 'failed' | 'completed' | 'stopped' | 'invalid' | 'paused' | 'never' | 'monitoring';

export default function SourcesPage() {
  const { user, token, ready, getFreshToken } = useAuth('admin');
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [runsError, setRunsError] = useState('');
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<number | null>(null);
  const [scheduleDraft, setScheduleDraft] = useState('');
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [form, setForm] = useState({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
  const [promptSource, setPromptSource] = useState<SourceRecord | null>(null);
  const [promptText, setPromptText] = useState('');
  const [promptVersion, setPromptVersion] = useState(0);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptError, setPromptError] = useState('');
  const pollRef = useRef<number | null>(null);

  const authHeaders = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const loadSources = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/sources', { headers: authHeaders() });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(payload)) throw new Error(payload?.error || 'Sources could not be loaded.');
      setSources(payload);
      setLoadError('');
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Sources could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [token, authHeaders]);

  const loadRuns = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/agent/runs?limit=30', { headers: authHeaders() });
      if (!response.ok) throw new Error('Run telemetry could not be loaded.');
      const payload = await response.json();
      setRuns(Array.isArray(payload.runs) ? payload.runs : []);
      setRunsError('');
      if (!payload.has_active) loadSources();
    } catch (error) {
      setRunsError(error instanceof Error ? error.message : 'Run telemetry could not be loaded.');
      void loadSources();
    }
  }, [token, authHeaders, loadSources]);

  useEffect(() => {
    if (!ready || !token) return;
    loadSources();
    loadRuns();
    pollRef.current = window.setInterval(loadRuns, 10_000);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [ready, token, loadSources, loadRuns]);

  useEffect(() => {
    if (!addOpen && !promptSource) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setAddOpen(false);
      setPromptSource(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [addOpen, promptSource]);

  function showToast(message: string, error = false) {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 3800);
  }

  function latestRunFor(sourceId: number) {
    return runs.find(run => run.source_id === sourceId);
  }

  function sourceHealth(source: SourceRecord, run?: RunRecord): Health {
    if (!source.active) return 'paused';
    if (run?.status === 'running') return 'running';
    if (run?.status === 'failed') return 'failed';
    if (run?.status === 'stopped') return 'stopped';
    if (run?.status === 'completed') return 'completed';

    const states: Record<NonNullable<SourceRecord['health_status']>, Health> = {
      disabled: 'paused',
      invalid_schedule: 'invalid',
      no_run_history: 'never',
      running: 'running',
      last_run_completed: 'completed',
      last_run_failed: 'failed',
      last_run_stopped: 'stopped',
      unknown_run_state: 'monitoring',
    };
    if (source.health_status) return states[source.health_status];
    if (source.schedule_valid === false) return 'invalid';
    if (source.last_run_status === 'failed') return 'failed';
    if (source.last_run_status === 'completed') return 'completed';
    if (source.last_run_status === 'stopped') return 'stopped';
    if (!source.last_run_status) return 'never';
    return 'monitoring';
  }

  function beginScheduleEdit(source: SourceRecord) {
    setScheduleDraft(source.schedule_cron);
    setEditingSchedule(source.id);
  }

  function copyEndpoint(slug: string) {
    const origin = process.env.NEXT_PUBLIC_APP_URL || window.location.origin;
    navigator.clipboard.writeText(`${origin}/api/ingest/${slug}`).then(() => {
      setCopiedSlug(slug);
      window.setTimeout(() => setCopiedSlug(null), 1800);
    }).catch(() => showToast('The endpoint could not be copied.', true));
  }

  async function saveSchedule(sourceId: number, scheduleCron: string) {
    if (!scheduleCron.trim()) {
      showToast('Enter a five-field cron expression.', true);
      return;
    }
    setScheduleSaving(true);
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/sources/${sourceId}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify({ schedule_cron: scheduleCron.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Schedule could not be updated.');
      setEditingSchedule(null);
      await loadSources();
      showToast('Source cron schedule updated.');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Schedule could not be updated.', true);
    } finally {
      setScheduleSaving(false);
    }
  }

  async function triggerRun(source: SourceRecord) {
    setTriggering(source.id);
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/agent/trigger/${source.id}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The run could not be started.');
      showToast(`${source.name} run requested.`);
      window.setTimeout(loadRuns, 900);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The run could not be started.', true);
    } finally {
      setTriggering(null);
    }
  }

  async function stopRun(run: RunRecord) {
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/agent/runs/${run.id}/stop`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'The run could not be stopped.');
      showToast(`${run.source_name} stop requested.`);
      loadRuns();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The run could not be stopped.', true);
    }
  }

  async function toggleActive(source: SourceRecord) {
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/sources/${source.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify({ active: source.active ? 0 : 1 }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Source status could not be changed.');
      await loadSources();
      showToast(`${source.name} ${source.active ? 'paused' : 'enabled'}.`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Source status could not be changed.', true);
    }
  }

  async function deleteSource(source: SourceRecord) {
    const confirmed = window.confirm(`Delete “${source.name}”?\n\nThis permanently deletes the source and its events and run history.`);
    if (!confirmed) return;
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/sources/${source.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Source could not be deleted.');
      showToast(`${source.name} deleted.`);
      loadSources();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Source could not be deleted.', true);
    }
  }

  async function addSource() {
    setAdding(true);
    setAddError('');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    try {
      const freshToken = await getFreshToken();
      const response = await fetch('/api/sources', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Source could not be added.');
      setAddOpen(false);
      setForm({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
      showToast(`${payload.name || form.name} added. The ingest endpoint is ready.`);
      loadSources();
    } catch (error) {
      setAddError(error instanceof DOMException && error.name === 'AbortError'
        ? 'The request timed out. Try again.'
        : error instanceof Error ? error.message : 'Source could not be added.');
    } finally {
      window.clearTimeout(timeout);
      setAdding(false);
    }
  }

  async function openPrompt(source: SourceRecord) {
    setPromptSource(source);
    setPromptText('');
    setPromptVersion(0);
    setPromptError('');
    setPromptLoading(true);
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/sources/${source.id}/system-prompt`, {
        headers: { Authorization: `Bearer ${freshToken}` },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || 'Extraction instructions could not be loaded.');
      setPromptText(payload.system || '');
      setPromptVersion(Number(payload.version) || 0);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : 'Extraction instructions could not be loaded.');
    } finally {
      setPromptLoading(false);
    }
  }

  async function savePrompt() {
    if (!promptSource) return;
    setPromptSaving(true);
    setPromptError('');
    try {
      const freshToken = await getFreshToken();
      const response = await fetch(`/api/sources/${promptSource.id}/system-prompt`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify({ system: promptText, version: promptVersion }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409) throw new Error('These instructions changed elsewhere. Close and reopen the drawer before saving.');
        throw new Error(payload.error || 'Extraction instructions could not be saved.');
      }
      setPromptVersion(Number(payload.version) || promptVersion);
      showToast(`Extraction instructions saved as version ${payload.version}.`);
    } catch (error) {
      setPromptError(error instanceof Error ? error.message : 'Extraction instructions could not be saved.');
    } finally {
      setPromptSaving(false);
    }
  }

  if (!ready || !user) return null;

  const activeRuns = runs.filter(run => run.status === 'running');
  const failedSources = sources.filter(source => sourceHealth(
    source,
    runsError ? undefined : latestRunFor(source.id),
  ) === 'failed');
  const invalidScheduleSources = sources.filter(source =>
    source.schedule_valid === false || source.health_status === 'invalid_schedule'
  );
  const enabledSources = sources.filter(source => Boolean(source.active));
  const completedRuns = runs.filter(run => run.status !== 'running');

  return (
    <AppShell role="admin" name={user.name} email={user.email} token={token} workspaceLabel="Source operations">
      <div aria-live="polite" aria-atomic="true">
        {toast && <div className={`toast ${toast.error ? 'toast--error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.message}</div>}
      </div>
      <datalist id="schedule-presets">
        {SCHEDULE_PRESETS.map(option => <option key={option.value} value={option.value} label={option.label} />)}
      </datalist>

      <main className="page-main">
        <header className="page-header">
          <div>
            <div className="page-header__eyebrow">Ingestion operations</div>
            <h1>Sources & runs</h1>
            <p>Monitor source health, inspect run failures, start an immediate extraction, and manage the exact ingest endpoint for each source.</p>
          </div>
          <div className="page-header__actions">
            <button type="button" className="btn-secondary" onClick={() => { loadSources(); loadRuns(); }}><RefreshCcw size={15} /> Refresh</button>
            <button type="button" className="btn-primary" onClick={() => setAddOpen(true)}><Plus size={15} /> Add source</button>
          </div>
        </header>

        <section className="ops-health" aria-label="Source health summary">
          <HealthCard label="Enabled sources" value={enabledSources.length} icon={<Database size={18} color="var(--green-700)" />} />
          <HealthCard label="Running now" value={runsError ? '—' : activeRuns.length} icon={<Activity size={18} color="var(--green-600)" />} />
          <HealthCard label="Failed latest run" value={failedSources.length} icon={<XCircle size={18} color="var(--red-600)" />} />
          <HealthCard label="Invalid schedules" value={invalidScheduleSources.length} icon={<Clock3 size={18} color="var(--amber-600)" />} />
        </section>

        <div className="ops-banner" id="scheduler-contract">
          <AlertTriangle size={17} aria-hidden="true" />
          <span><strong>Schedules use Oberlin time.</strong> The hourly dispatcher catches up work due within the previous six hours, so a delayed hourly check does not silently skip a source. “Run now” requests an immediate run. Raw five-field cron is available only while editing.</span>
        </div>

        {!runsError && activeRuns.length > 0 && (
          <div className="alert alert--success" style={{ marginBottom: 16 }}>
            <LoaderCircle size={17} style={{ animation: 'spin .8s linear infinite' }} />
            <span><strong>{activeRuns.length} active {activeRuns.length === 1 ? 'run' : 'runs'}:</strong> {activeRuns.map(run => `${run.source_name} (${run.events_extracted || 0} extracted, ${run.elapsed_sec || 0}s)`).join(' · ')}</span>
          </div>
        )}

        {loadError && <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}><XCircle size={17} /> {loadError}</div>}
        {runsError && <div className="alert alert--warning" role="alert" style={{ marginBottom: 16 }}><AlertTriangle size={17} /> Live run polling is unavailable: {runsError} Source cards use the latest operations snapshot, but live progress and stop controls may be unavailable.</div>}

        {loading ? (
          <div className="loading-state" role="status"><span className="spinner" /> Loading sources and run history…</div>
        ) : sources.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon"><Database size={23} /></span>
            <h2>No sources configured</h2>
            <p>Add a source to create its ingest endpoint and managed extraction configuration.</p>
            <button type="button" className="btn-primary" style={{ marginTop: 16 }} onClick={() => setAddOpen(true)}><Plus size={14} /> Add first source</button>
          </div>
        ) : (
          <section className="source-grid" aria-label="Configured sources">
            {sources.map(source => {
              const run = runsError ? undefined : latestRunFor(source.id);
              const health = sourceHealth(source, run);
              const isEmail = source.source_type === 'email';
              const isCorrection = source.slug === 'fixed-events';
              const scheduleDescription = describeCronExpression(source.schedule_cron);
              const lastActivity = run?.started_at || source.last_run_started_at || source.last_run_at;
              const failureDetails = run?.error_log
                ?? source.last_error
                ?? source.recent_runs?.[0]?.error_summary;
              const otherLifecycleCount = Number(source.total_resubmitted || 0)
                + Number(source.total_publishing || 0)
                + Number(source.total_superseded || 0);
              return (
                <article className="source-card" data-health={health} key={source.id}>
                  <div className="source-card__header">
                    <div className="source-card__identity">
                      <span className="source-card__icon">
                        {isEmail ? <Mail size={18} /> : isCorrection ? <RefreshCcw size={18} /> : <Database size={18} />}
                      </span>
                      <div style={{ minWidth: 0 }}>
                        <div className="source-card__name">{source.name}</div>
                        <div className="source-card__slug">{isEmail ? (process.env.NEXT_PUBLIC_SMTP_USER || 'Server-configured inbox') : `/api/ingest/${source.slug}`}</div>
                      </div>
                    </div>
                    <HealthBadge
                      health={health}
                      reason={run ? `Live run status: ${run.status}` : source.health_reason}
                    />
                  </div>

                  <div className="source-card__metrics">
                    <div className="source-card__metric">
                      <div className="source-card__metric-label">Records in system</div>
                      <div className="source-card__metric-value tnum">{Number(source.total_events) || 0}</div>
                    </div>
                    <div className="source-card__metric">
                      <div className="source-card__metric-label">Review queue</div>
                      <div className="source-card__metric-value tnum">{Number(source.review_queue) || 0}</div>
                    </div>
                    <div className="source-card__metric" title="Records currently being corrected and temporarily outside human review">
                      <div className="source-card__metric-label">Correction jobs</div>
                      <div className="source-card__metric-value tnum">{Number(source.pending_fix) || 0}</div>
                    </div>
                    <div className="source-card__metric">
                      <div className="source-card__metric-label">Published</div>
                      <div className="source-card__metric-value tnum">{Number(source.total_approved) || 0}</div>
                    </div>
                    <div className="source-card__metric" title="Rejected records with no correction currently running">
                      <div className="source-card__metric-label">Rejected · idle</div>
                      <div className="source-card__metric-value tnum">{Number(source.total_rejected) || 0}</div>
                    </div>
                    <div className="source-card__metric" title="Publishing, resubmitted, or replaced by a corrected draft">
                      <div className="source-card__metric-label">Other lifecycle</div>
                      <div className="source-card__metric-value tnum">{otherLifecycleCount}</div>
                    </div>
                  </div>

                  {!isEmail && (
                    <div className="source-card__row">
                      <span className="source-card__row-label">Ingest endpoint</span>
                      <button type="button" className="btn-ghost" style={{ minHeight: 32, paddingInline: 10 }} onClick={() => copyEndpoint(source.slug)}>
                        {copiedSlug === source.slug ? <Check size={13} /> : <Copy size={13} />}
                        {copiedSlug === source.slug ? 'Copied' : 'Copy URL'}
                      </button>
                    </div>
                  )}

                  <div className="source-card__row">
                    <span className="source-card__row-label">Schedule</span>
                    {editingSchedule === source.id ? (
                      <form
                        onSubmit={event => {
                          event.preventDefault();
                          void saveSchedule(source.id, scheduleDraft);
                        }}
                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6 }}
                      >
                        <input
                          className="input tnum"
                          aria-label={`Five-field cron schedule for ${source.name}`}
                          aria-describedby="scheduler-contract"
                          aria-invalid={source.schedule_valid === false}
                          list="schedule-presets"
                          value={scheduleDraft}
                          style={{ width: 160, minHeight: 34, paddingBlock: 5 }}
                          onChange={event => setScheduleDraft(event.target.value)}
                          autoComplete="off"
                          autoFocus
                        />
                        <button type="submit" className="btn-primary" style={{ minHeight: 32, paddingInline: 10 }} disabled={scheduleSaving || !scheduleDraft.trim()}>
                          {scheduleSaving ? <span className="spinner" /> : <Check size={13} />} Save
                        </button>
                        <button type="button" className="btn-ghost" style={{ minHeight: 32, paddingInline: 8 }} onClick={() => setEditingSchedule(null)} disabled={scheduleSaving}>Cancel</button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost"
                        style={{ minHeight: 32, paddingInline: 10 }}
                        title={`Edit advanced schedule (${source.schedule_cron})`}
                        onClick={() => beginScheduleEdit(source)}
                      >
                        <Pencil size={12} /> {scheduleDescription}
                      </button>
                    )}
                  </div>

                  <div className="source-card__row">
                    <span className="source-card__row-label">Next matching slot</span>
                    <span title="This is the cron match; the hourly dispatcher may start it later.">
                      {!source.active
                        ? 'Paused'
                        : source.schedule_valid === false
                          ? 'Unavailable'
                          : source.next_run_at
                            ? formatScheduledSlot(source.next_run_at, source.schedule_timezone)
                            : 'No upcoming slot found'}
                    </span>
                  </div>

                  <div className="source-card__row">
                    <span className="source-card__row-label">Last activity</span>
                    <span>{run?.status === 'running' ? `Running · ${run.elapsed_sec || 0}s` : lastActivity ? new Date(lastActivity).toLocaleString() : 'Never run'}</span>
                  </div>

                  {source.schedule_valid === false && (
                    <div className="alert alert--warning" role="alert" style={{ marginTop: 10 }}>
                      <AlertTriangle size={15} />
                      <span><strong>Invalid cron:</strong> {source.schedule_error || 'Enter exactly five supported fields.'}</span>
                    </div>
                  )}

                  {Number(source.validation_issues) > 0 && (
                    <div className="alert alert--warning" style={{ marginTop: 10 }}>
                      <ShieldCheck size={15} />
                      <span>{Number(source.validation_issues)} {Number(source.validation_issues) === 1 ? 'record has' : 'records have'} CommunityHub payload issues.</span>
                    </div>
                  )}

                  {isCorrection && source.fix_stats && (
                    <div className="alert alert--info" style={{ marginTop: 10 }}>
                      <RefreshCcw size={15} />
                      <span>{source.fix_stats.pending_fix || 0} waiting · {source.fix_stats.fixed_approved || 0} returned records published</span>
                    </div>
                  )}

                  {health === 'failed' && Boolean(failureDetails) && (
                    <details className="payload-preview" style={{ marginTop: 10 }}>
                      <summary style={{ color: 'var(--red-700)' }}>Latest failure details</summary>
                      <pre>{formatErrorLog(failureDetails)}</pre>
                    </details>
                  )}

                  <div className="source-card__actions">
                    {run?.status === 'running' ? (
                      <button type="button" className="btn-danger" onClick={() => stopRun(run)}><Square size={13} /> Stop run</button>
                    ) : !isCorrection ? (
                      <button type="button" className="btn-primary" onClick={() => triggerRun(source)} disabled={!source.active || triggering === source.id}>
                        {triggering === source.id ? <><span className="spinner" /> Requesting…</> : <><Play size={13} /> Run now</>}
                      </button>
                    ) : null}
                    <button type="button" className="btn-secondary" onClick={() => toggleActive(source)} aria-pressed={Boolean(source.active)}>
                      {source.active ? <PauseCircle size={14} /> : <CheckCircle2 size={14} />}
                      {source.active ? 'Pause' : 'Enable'}
                    </button>
                    {!isEmail && <button type="button" className="icon-btn" aria-label={`Edit extraction instructions for ${source.name}`} title="Extraction instructions" onClick={() => openPrompt(source)}><FileText size={15} /></button>}
                    <button type="button" className="icon-btn" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => deleteSource(source)}><Trash2 size={15} /></button>
                  </div>
                </article>
              );
            })}
          </section>
        )}

        <section style={{ marginTop: 28 }}>
          <div className="card__header">
            <div>
              <h2 className="card__title">Recent run history</h2>
              <p className="card__subtitle">Completed, stopped, and failed work with counts and diagnostic output.</p>
            </div>
          </div>
          {completedRuns.length === 0 ? (
            <div className="empty-state" style={{ padding: 32 }}><p>No completed runs have been reported.</p></div>
          ) : (
            <div className="run-list">
              {completedRuns.slice(0, 12).map(run => (
                <article className="run-row" key={run.id}>
                  <div className="run-row__summary">
                    {run.status === 'completed'
                      ? <CheckCircle2 size={17} color="var(--green-600)" aria-label="Completed" />
                      : run.status === 'failed'
                        ? <XCircle size={17} color="var(--red-600)" aria-label="Failed" />
                        : <PauseCircle size={17} color="var(--amber-600)" aria-label={run.status} />}
                    <span className="run-row__name">{run.source_name}</span>
                    <span className="run-row__time">{new Date(run.started_at).toLocaleString()}</span>
                    <span className="badge badge-gray tnum">{Number(run.events_extracted) || 0} extracted</span>
                    <span className="run-row__meta tnum">{Number(run.elapsed_sec) || 0}s</span>
                  </div>
                  {Boolean(run.error_log) && (
                    <details>
                      <summary>View diagnostic details</summary>
                      <pre>{formatErrorLog(run.error_log)}</pre>
                    </details>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      {addOpen && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setAddOpen(false);
        }}>
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-source-title">
            <div className="dialog__header">
              <div>
                <h2 id="add-source-title">Add an extraction source</h2>
                <p>The current backend requires a managed agent ID and creates a unique ingest endpoint from the source name.</p>
              </div>
              <button type="button" className="icon-btn" aria-label="Close add source dialog" onClick={() => setAddOpen(false)}><X size={16} /></button>
            </div>
            <div className="dialog__body">
              {addError && <div className="alert alert--error" role="alert"><XCircle size={16} /> {addError}</div>}
              <div className="field">
                <label className="field__label" htmlFor="source-name">Organization or source name</label>
                <input id="source-name" className="input" value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="Apollo Theatre" autoFocus />
                {form.name && <span className="field__hint">Endpoint preview: /api/ingest/{form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}</span>}
              </div>
              <div className="field">
                <label className="field__label" htmlFor="source-agent-id">Managed agent ID</label>
                <input id="source-agent-id" className="input" value={form.agent_id} onChange={event => setForm(current => ({ ...current, agent_id: event.target.value }))} placeholder="agt_…" />
                <span className="field__hint">Required by the currently configured extraction provider.</span>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="source-schedule">Five-field cron schedule</label>
                <input
                  id="source-schedule"
                  className="input tnum"
                  list="schedule-presets"
                  aria-describedby="source-schedule-hint scheduler-contract"
                  value={form.schedule_cron}
                  onChange={event => setForm(current => ({ ...current, schedule_cron: event.target.value }))}
                  placeholder="minute hour day-of-month month day-of-week"
                  autoComplete="off"
                />
                <span className="field__hint" id="source-schedule-hint">Standard five-field cron in America/New_York. Presets are suggestions; custom expressions are accepted and validated by the server.</span>
              </div>
            </div>
            <div className="dialog__actions">
              <button type="button" className="btn-secondary" onClick={() => { setAddOpen(false); setAddError(''); }}>Cancel</button>
              <button type="button" className="btn-primary" onClick={addSource} disabled={!form.name.trim() || !form.agent_id.trim() || !form.schedule_cron.trim() || adding}>
                {adding ? <><span className="spinner" /> Adding…</> : <><Plus size={14} /> Add source</>}
              </button>
            </div>
          </section>
        </div>
      )}

      {promptSource && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setPromptSource(null);
        }}>
          <section className="drawer" role="dialog" aria-modal="true" aria-labelledby="prompt-drawer-title">
            <div className="drawer__header">
              <div>
                <h2 id="prompt-drawer-title" style={{ margin: 0, fontSize: 18 }}>{promptSource.name}</h2>
                <div className="field__hint">Extraction instructions · version {promptVersion || 'unversioned'}</div>
              </div>
              <button type="button" className="icon-btn" aria-label="Close extraction instructions" onClick={() => setPromptSource(null)}><X size={17} /></button>
            </div>
            <div className="drawer__body">
              <div className="alert alert--info" style={{ marginBottom: 14 }}>
                <ShieldCheck size={16} />
                <span>Reviewer corrections can be appended as source-specific context by the backend. Editing these instructions changes a prompt version; it does not retrain or make the model self-modifying.</span>
              </div>
              {promptError && <div className="alert alert--error" role="alert" style={{ marginBottom: 14 }}><XCircle size={16} /> {promptError}</div>}
              {promptLoading ? (
                <div className="loading-state" role="status"><span className="spinner" /> Loading extraction instructions…</div>
              ) : (
                <div className="field" style={{ flex: 1 }}>
                  <label className="field__label" htmlFor="prompt-editor">System instructions</label>
                  <textarea id="prompt-editor" className="input drawer__editor" spellCheck={false} value={promptText} onChange={event => setPromptText(event.target.value)} />
                  <span className="field__hint tnum">{promptText.length.toLocaleString()} characters</span>
                </div>
              )}
            </div>
            {!promptLoading && (
              <div className="drawer__footer">
                <button type="button" className="btn-secondary" onClick={() => setPromptSource(null)}>Close</button>
                <button type="button" className="btn-primary" onClick={savePrompt} disabled={promptSaving}>{promptSaving ? <><span className="spinner" /> Saving…</> : 'Save version'}</button>
              </div>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function HealthCard({ label, value, icon }: { label: string; value: number | string; icon: React.ReactNode }) {
  return (
    <div className="ops-health__card">
      <div className="ops-health__label">{label}</div>
      <div className="ops-health__value tnum">{icon}{value}</div>
    </div>
  );
}

function HealthBadge({ health, reason }: { health: Health; reason?: string }) {
  const labels: Record<Health, string> = {
    running: 'Running',
    failed: 'Last run failed',
    completed: 'Last run completed',
    stopped: 'Last run stopped',
    invalid: 'Invalid schedule',
    paused: 'Paused',
    never: 'Never run',
    monitoring: 'Status unknown',
  };
  const tones: Record<Health, string> = {
    running: 'badge-green',
    failed: 'badge-red',
    completed: 'badge-green',
    stopped: 'badge-amber',
    invalid: 'badge-red',
    paused: 'badge-gray',
    never: 'badge-blue',
    monitoring: 'badge-amber',
  };
  return <span className={`badge ${tones[health]}`} title={reason}>{labels[health]}</span>;
}

function formatErrorLog(value: unknown) {
  if (typeof value === 'string') {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value, null, 2);
}

function formatScheduledSlot(value: string, timeZone = 'America/New_York') {
  try {
    return `${new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value))} · ${timeZone}`;
  } catch {
    return `${new Date(value).toLocaleString()} · ${timeZone}`;
  }
}
