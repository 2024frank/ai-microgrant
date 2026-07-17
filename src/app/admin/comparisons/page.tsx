'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ExternalLink,
  RefreshCcw,
  XCircle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { useAuth } from '@/hooks/useAuth';

interface ComparisonRow {
  id: number;
  agent_run_id: number;
  source_id: number;
  source_name: string;
  source_slug: string;
  status: 'complete' | 'inventory_unavailable';
  remote_approved: number;
  remote_pending: number;
  matched_both: number;
  integration_only: number;
  calendar_only: number;
  duplicates_preserved: number;
  created_at: string;
  run_started_at?: string;
  run_status?: string;
}

interface FieldDiff { field: string; local: string; remote: string; equal: boolean }

interface ReportCandidate {
  index: number;
  title: string;
  outcome: string;
  event_id: number | null;
  duplicate_of_event_id: number | null;
  communityhub_match: null | {
    kind: string;
    reasons: string[];
    field_diffs: FieldDiff[];
    remote: { name?: string; moderation?: string; submission_origin?: string };
  };
  issues?: Array<{ path?: string; message?: string }>;
  adjustments?: string[];
}

interface ComparisonReport {
  source_names_used: string[];
  candidates: ReportCandidate[];
  calendar_only: Array<{
    name: string;
    moderation: string;
    submission_origin: string;
    calendar_source_name?: string;
    sessions?: Array<{ start: number; end: number }>;
  }>;
  counts: Record<string, number>;
  inventory_error: string | null;
}

const OUTCOME_LABELS: Record<string, string> = {
  inserted: 'New draft for review',
  duplicate_local: 'Duplicate of an earlier import',
  duplicate_cross_source: 'Duplicate of a more direct source',
  duplicate_communityhub: 'Already on the calendar (preserved)',
  auto_rejected: 'Rejected: required fields missing',
  invalid: 'Invalid extraction',
};

function formatSession(session?: { start: number; end: number }): string {
  if (!session) return '';
  return new Date(session.start * 1000).toLocaleString();
}

export default function AdminComparisonsPage() {
  const { user, token, ready } = useAuth('admin');
  const [rows, setRows] = useState<ComparisonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ComparisonRow | null>(null);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    if (!token) return;
    setLoading(true);
    fetch('/api/admin/comparisons', { headers: { Authorization: `Bearer ${token}` } })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'Comparisons could not be loaded.');
        return payload;
      })
      .then(payload => setRows(Array.isArray(payload.comparisons) ? payload.comparisons : []))
      .catch(loadError => setError(loadError instanceof Error ? loadError.message : 'Comparisons could not be loaded.'))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => { if (ready && token) load(); }, [ready, token, load]);

  function openReport(row: ComparisonRow) {
    if (!token) return;
    setSelected(row);
    setReport(null);
    setReportLoading(true);
    fetch(`/api/admin/comparisons?run_id=${row.agent_run_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || 'The report could not be loaded.');
        return payload;
      })
      .then(payload => setReport(payload.report ?? null))
      .catch(() => setReport(null))
      .finally(() => setReportLoading(false));
  }

  if (!ready || !user) return null;

  return (
    <AppShell role={user.role} name={user.name} email={user.email} token={token} workspaceLabel="Calendar comparison">
      <main className="page-main">
        <header className="studio-header">
          <div>
            <h1>Integration vs calendar</h1>
            <p>
              Every integration run is compared both ways against the live CommunityHub
              calendar: what the integration found, what the calendar already had (including
              direct submissions from the organization), and where the two versions differ.
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={load} disabled={loading}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </header>

        {error && <div className="alert alert--error"><XCircle size={16} /> {error}</div>}
        {loading ? (
          <div className="loading-state" role="status"><span className="spinner" /> Loading run comparisons…</div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-state__icon"><ArrowLeftRight size={23} /></span>
            <h2>No comparisons yet</h2>
            <p>Comparisons are recorded automatically the next time an integration runs.</p>
          </div>
        ) : (
          <section className="card" style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th style={{ padding: '8px 10px' }}>Run</th>
                  <th style={{ padding: '8px 10px' }}>Source</th>
                  <th style={{ padding: '8px 10px' }}>Found by both</th>
                  <th style={{ padding: '8px 10px' }}>Integration only</th>
                  <th style={{ padding: '8px 10px' }}>Calendar only (missed)</th>
                  <th style={{ padding: '8px 10px' }}>Duplicates preserved</th>
                  <th style={{ padding: '8px 10px' }}>Status</th>
                  <th style={{ padding: '8px 10px' }} aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} style={{ borderTop: '1px solid var(--ink-100, #eee)' }}>
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      #{row.agent_run_id}<br />
                      <span style={{ color: 'var(--ink-400, #888)' }}>{new Date(row.created_at).toLocaleString()}</span>
                    </td>
                    <td style={{ padding: '8px 10px' }}>{row.source_name}</td>
                    <td style={{ padding: '8px 10px' }}>{row.matched_both}</td>
                    <td style={{ padding: '8px 10px' }}>{row.integration_only}</td>
                    <td style={{ padding: '8px 10px' }}>
                      {row.calendar_only > 0
                        ? <span className="badge badge-amber"><AlertTriangle size={11} /> {row.calendar_only}</span>
                        : <span className="badge badge-green"><CheckCircle2 size={11} /> 0</span>}
                    </td>
                    <td style={{ padding: '8px 10px' }}>{row.duplicates_preserved}</td>
                    <td style={{ padding: '8px 10px' }}>
                      {row.status === 'complete'
                        ? <span className="badge badge-green">complete</span>
                        : <span className="badge badge-amber">inventory unavailable</span>}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <button type="button" className="btn-secondary" onClick={() => openReport(row)}>Details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {selected && (
          <div className="dialog-backdrop" role="presentation" onMouseDown={event => {
            if (event.target === event.currentTarget) setSelected(null);
          }}>
            <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="comparison-title" style={{ maxWidth: 860, maxHeight: '85vh', overflowY: 'auto' }}>
              <div className="dialog__header">
                <div>
                  <h2 id="comparison-title">Run #{selected.agent_run_id} · {selected.source_name}</h2>
                  <p>Two-way comparison against the CommunityHub calendar at run time.</p>
                </div>
                <button type="button" className="icon-btn" aria-label="Close comparison" onClick={() => setSelected(null)}><XCircle size={16} /></button>
              </div>
              {reportLoading ? (
                <div className="loading-state" role="status"><span className="spinner" /> Loading report…</div>
              ) : !report ? (
                <div className="alert alert--error"><XCircle size={16} /> The full report could not be loaded.</div>
              ) : (
                <div style={{ display: 'grid', gap: 16 }}>
                  {report.inventory_error && (
                    <div className="alert alert--warning">
                      <AlertTriangle size={16} />
                      <span>The CommunityHub inventory was unavailable for this run: {report.inventory_error}</span>
                    </div>
                  )}

                  <section>
                    <h3 style={{ margin: '0 0 8px' }}>Events the integration found ({report.candidates.length})</h3>
                    <div style={{ display: 'grid', gap: 10 }}>
                      {report.candidates.map(candidate => (
                        <div className="card" key={candidate.index} style={{ padding: 12 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <strong>{candidate.title}</strong>
                            <span className="badge">{OUTCOME_LABELS[candidate.outcome] ?? candidate.outcome}</span>
                          </div>
                          {candidate.event_id !== null && (
                            <a href={`/reviewer/events/${candidate.event_id}`} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                              <ExternalLink size={11} style={{ verticalAlign: 'middle' }} /> Open record #{candidate.event_id}
                            </a>
                          )}
                          {candidate.communityhub_match && (
                            <div style={{ marginTop: 8, fontSize: 13 }}>
                              Matched calendar post “{candidate.communityhub_match.remote?.name}” ({candidate.communityhub_match.remote?.submission_origin === 'direct_submission' ? 'direct submission' : 'posted by this application'}, {candidate.communityhub_match.remote?.moderation}; {candidate.communityhub_match.kind} match)
                              {candidate.communityhub_match.field_diffs.some(diff => !diff.equal) && (
                                <details style={{ marginTop: 6 }}>
                                  <summary>Field differences</summary>
                                  <div style={{ display: 'grid', gap: 6, marginTop: 6 }}>
                                    {candidate.communityhub_match.field_diffs.filter(diff => !diff.equal).map(diff => (
                                      <div key={diff.field}>
                                        <strong>{diff.field}</strong><br />
                                        imported: {diff.local || '(empty)'}<br />
                                        calendar: {diff.remote || '(empty)'}
                                      </div>
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                          )}
                          {Boolean(candidate.issues?.length) && (
                            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--red-700, #b00)' }}>
                              {candidate.issues!.slice(0, 4).map((item, itemIndex) => (
                                <div key={itemIndex}>{item.path}: {item.message}</div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                      {report.candidates.length === 0 && <p>The run returned no candidates.</p>}
                    </div>
                  </section>

                  <section>
                    <h3 style={{ margin: '0 0 8px' }}>
                      Calendar events the integration missed ({report.calendar_only.length})
                    </h3>
                    <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--ink-500, #666)' }}>
                      Attributed to {report.source_names_used.join(' / ') || 'this organization'} on the calendar
                      but matched by nothing the integration has collected.
                    </p>
                    <div style={{ display: 'grid', gap: 8 }}>
                      {report.calendar_only.map((post, postIndex) => (
                        <div className="card" key={postIndex} style={{ padding: 12 }}>
                          <strong>{post.name}</strong>
                          <div style={{ fontSize: 12, color: 'var(--ink-500, #666)' }}>
                            {post.submission_origin === 'direct_submission' ? 'Direct calendar submission' : 'Posted by this application'} · {post.moderation}
                            {post.sessions?.length ? ` · ${formatSession(post.sessions[0])}` : ''}
                          </div>
                        </div>
                      ))}
                      {report.calendar_only.length === 0 && (
                        <p style={{ fontSize: 13 }}><CheckCircle2 size={13} style={{ verticalAlign: 'middle' }} /> Nothing attributed to this organization was missed.</p>
                      )}
                    </div>
                  </section>
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </AppShell>
  );
}
