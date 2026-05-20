'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { Plus, Play, Square, Trash2, ToggleLeft, ToggleRight, CheckCircle, XCircle, Loader, Copy, Check, Pencil, Wrench, FileText, X } from 'lucide-react';

const SCHEDULE_OPTIONS = [
  { label: 'Every hour',    value: '0 * * * *'   },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily (6am)',   value: '0 6 * * *'   },
  { label: 'Daily (noon)',  value: '0 12 * * *'  },
  { label: 'Weekly',        value: '0 6 * * 1'   },
];

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';

export default function SourcesPage() {
  const { user, token, ready, getFreshToken } = useAuth('admin');
  const [sources, setSources]       = useState<any[]>([]);
  const [runs, setRuns]             = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [form, setForm]             = useState({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
  const [adding, setAdding]         = useState(false);
  const [addError, setAddError]     = useState('');
  const [triggering, setTriggering] = useState<number | null>(null);
  const [toast, setToast]           = useState('');
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [editingSchedule, setEditingSchedule] = useState<number | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  // System prompt drawer
  const [promptSource, setPromptSource]     = useState<any | null>(null);
  const [promptText, setPromptText]         = useState('');
  const [promptVersion, setPromptVersion]   = useState(0);
  const [promptLoading, setPromptLoading]   = useState(false);
  const [promptSaving, setPromptSaving]     = useState(false);
  const [promptError, setPromptError]       = useState('');

  const h = useCallback(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const loadSources = useCallback(() => {
    if (!token) return;
    fetch('/api/sources', { headers: h() })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setSources(d); })
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, [token, h]);

  const loadRuns = useCallback(() => {
    if (!token) return;
    fetch('/api/agent/runs?limit=20', { headers: h() })
      .then(r => r.json())
      .then(d => {
        setRuns(d.runs || []);
        if (d.has_active) {
          pollRef.current = setTimeout(loadRuns, 1000);
        } else {
          loadSources();
        }
      }).catch(() => {});
  }, [token, h, loadSources]);

  useEffect(() => {
    if (!ready || !token) return;
    loadSources();
    loadRuns();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [ready, token]); // eslint-disable-line

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  function copyEndpoint(slug: string) {
    const url = `${APP_URL}/api/ingest/${slug}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedSlug(slug);
      setTimeout(() => setCopiedSlug(null), 2000);
    });
  }

  async function addSource() {
    setAdding(true); setAddError('');
    const controller = new AbortController();
    const tid = setTimeout(() => { controller.abort(); setAdding(false); setAddError('Request timed out — please try again'); }, 12000);
    try {
      const freshToken = await getFreshToken();
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      clearTimeout(tid);
      const data = await res.json();
      if (!res.ok) { setAddError(data.error || 'Failed'); setAdding(false); return; }
      setShowAdd(false);
      setForm({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
      setAdding(false);
      loadSources();
      showToast(`✓ ${data.name} added! Ingest endpoint ready.`);
    } catch (err: any) {
      clearTimeout(tid);
      if (err.name !== 'AbortError') { setAddError(`Error: ${err.message}`); setAdding(false); }
    }
  }

  async function saveSchedule(sourceId: number, schedule_cron: string) {
    const freshToken = await getFreshToken();
    await fetch(`/api/sources/${sourceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
      body: JSON.stringify({ schedule_cron }),
    });
    setEditingSchedule(null);
    loadSources();
    showToast('Schedule updated');
  }

  async function triggerRun(sourceId: number) {
    setTriggering(sourceId);
    try {
      const freshToken = await getFreshToken();
      const res  = await fetch(`/api/agent/trigger/${sourceId}`, { method: 'POST', headers: { Authorization: `Bearer ${freshToken}` } });
      let data: any = {};
      try { data = await res.json(); } catch {}
      if (!res.ok) showToast(`Error: ${data.error || 'Failed'}`);
      else { showToast(`Agent started for ${data.source || 'source'}`); setTimeout(loadRuns, 1000); }
    } catch (err: any) { showToast(`Error: ${err.message}`); }
    finally { setTriggering(null); }
  }

  async function stopRun(runId: number) {
    const freshToken = await getFreshToken();
    const res = await fetch(`/api/agent/runs/${runId}/stop`, { method: 'POST', headers: { Authorization: `Bearer ${freshToken}` } });
    const data = await res.json().catch(() => ({}));
    if (res.ok) { showToast('Run stopped'); }
    else if (res.status === 400) { showToast('Run already finished'); }
    else { showToast(`Error: ${data.error || 'unknown'}`); }
    loadRuns();
  }

  async function deleteSource(source: any) {
    if (!confirm(`Delete "${source.name}"?\n\nThis will permanently delete the source and ALL its events and runs from the database.`)) return;
    const freshToken = await getFreshToken();
    const res = await fetch(`/api/sources/${source.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${freshToken}` },
    });
    if (res.ok) { showToast(`✓ ${source.name} deleted`); loadSources(); }
    else showToast('Failed to delete source');
  }

  async function openPromptDrawer(source: any) {
    setPromptSource(source);
    setPromptText('');
    setPromptVersion(0);
    setPromptError('');
    setPromptLoading(true);
    try {
      const freshToken = await getFreshToken();
      const res  = await fetch(`/api/sources/${source.id}/system-prompt`, { headers: { Authorization: `Bearer ${freshToken}` } });
      const data = await res.json();
      if (!res.ok) { setPromptError(data.error || 'Failed to load'); setPromptLoading(false); return; }
      setPromptText(data.system);
      setPromptVersion(data.version);
    } catch (err: any) { setPromptError(err.message); }
    setPromptLoading(false);
  }

  async function savePrompt() {
    if (!promptSource) return;
    setPromptSaving(true); setPromptError('');
    try {
      const freshToken = await getFreshToken();
      const res  = await fetch(`/api/sources/${promptSource.id}/system-prompt`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ system: promptText, version: promptVersion }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setPromptError('Version conflict — someone else updated this agent. Reload to get the latest version.');
        else setPromptError(data.error || 'Save failed');
        setPromptSaving(false);
        return;
      }
      setPromptVersion(data.version);
      showToast(`✓ System prompt updated (v${data.version})`);
    } catch (err: any) { setPromptError(err.message); }
    setPromptSaving(false);
  }

  async function toggleActive(source: any) {
    const freshToken = await getFreshToken();
    await fetch(`/api/sources/${source.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
      body: JSON.stringify({ active: source.active ? 0 : 1 }),
    });
    loadSources();
  }

  if (!ready || !user) return null;

  const latestRunBySource: Record<number, any> = {};
  for (const r of runs) { if (!latestRunBySource[r.source_id]) latestRunBySource[r.source_id] = r; }
  const activeRuns = runs.filter(r => r.status === 'running');

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token}/>

      {toast && (
        <div style={{ position: 'fixed', top: 20, right: 20, background: '#3a8c3f', color: 'white', padding: '0.75rem 1.25rem', borderRadius: 8, fontSize: 13, fontWeight: 500, zIndex: 999, boxShadow: '0 4px 16px rgba(0,0,0,0.15)' }}>
          {toast}
        </div>
      )}

      <main style={{ flex: 1, padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>Event Sources</h1>
            <p style={{ fontSize: 13, color: '#888' }}>Each source gets a unique ingest endpoint — paste it into your agent's system prompt</p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Plus size={15}/> Add source
          </button>
        </div>

        {/* Live run banner — one pill per active run */}
        {activeRuns.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: '1.25rem' }}>
            {activeRuns.map(r => (
              <div key={r.id} style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', borderRadius: 20, padding: '0.4rem 0.875rem', display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <Loader size={13} color="#3a8c3f" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}/>
                <strong style={{ color: '#2a6b2e' }}>{r.source_name}</strong>
                <span style={{ color: '#3a8c3f' }}>{r.events_extracted} extracted · {r.elapsed_sec}s</span>
                <button onClick={() => stopRun(r.id)}
                  style={{ background: '#c0392b', border: 'none', borderRadius: 10, padding: '2px 8px', cursor: 'pointer', color: 'white', fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, marginLeft: 2 }}>
                  <Square size={9} fill="white"/> Stop
                </button>
              </div>
            ))}
          </div>
        )}

        {loading ? (
          <div style={{ color: '#888', fontSize: 14, padding: '3rem', textAlign: 'center' }}>Loading…</div>
        ) : (
          <>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8f9fa', borderBottom: '1px solid #eee' }}>
                    {['Source', 'Ingest endpoint', 'Schedule', 'Last run', 'Events', 'Active', '', ''].map(h => (
                      <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sources.map(s => {
                    const run = latestRunBySource[s.id];
                    const isRunning = run?.status === 'running';
                    const isFixAgent = s.slug === 'fixed-events';

                    return (
                      <tr key={s.id} style={{ borderBottom: '1px solid #f0f0f0', background: isFixAgent ? '#fffdf7' : undefined }}>
                        <td style={{ padding: '0.875rem 1rem', fontWeight: 600 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {isFixAgent && <Wrench size={13} color="#c05e00"/>}
                            {s.name}
                            {isFixAgent && (
                              <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 10, background: '#fff3e0', color: '#c05e00', letterSpacing: 0.5, textTransform: 'uppercase' }}>
                                Correction Agent
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Ingest endpoint — copy button */}
                        <td style={{ padding: '0.875rem 1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <code style={{ fontSize: 11, color: '#666', background: '#f5f5f5', padding: '2px 6px', borderRadius: 4, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                              /api/ingest/{s.slug}
                            </code>
                            <button onClick={() => copyEndpoint(s.slug)}
                              title="Copy full URL"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: copiedSlug === s.slug ? '#3a8c3f' : '#aaa', padding: 0, flexShrink: 0 }}>
                              {copiedSlug === s.slug ? <Check size={14}/> : <Copy size={14}/>}
                            </button>
                          </div>
                        </td>

                        {/* Schedule — inline editable */}
                        <td style={{ padding: '0.875rem 1rem' }}>
                          {editingSchedule === s.id ? (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                              <select
                                defaultValue={s.schedule_cron}
                                onChange={e => saveSchedule(s.id, e.target.value)}
                                style={{ fontSize: 12, padding: '2px 6px', border: '1.5px solid #3a8c3f', borderRadius: 4, outline: 'none' }}
                                autoFocus
                                onBlur={() => setEditingSchedule(null)}>
                                {SCHEDULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          ) : (
                            <button onClick={() => setEditingSchedule(s.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, color: '#555', fontSize: 12, padding: 0 }}>
                              {SCHEDULE_OPTIONS.find(o => o.value === s.schedule_cron)?.label || s.schedule_cron}
                              <Pencil size={10} color="#bbb"/>
                            </button>
                          )}
                        </td>

                        <td style={{ padding: '0.875rem 1rem', fontSize: 12 }}>
                          {isRunning ? (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#3a8c3f', fontWeight: 600 }}>
                              <Loader size={11} style={{ animation: 'spin 1s linear infinite' }}/> Running…
                            </span>
                          ) : run ? (
                            <span style={{ color: '#888' }}>{new Date(run.started_at).toLocaleDateString()}</span>
                          ) : <span style={{ color: '#ddd' }}>Never</span>}
                        </td>

                        <td style={{ padding: '0.875rem 1rem', fontSize: 12 }}>
                          {isFixAgent ? (
                            s.fix_stats ? (
                              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                <span title="Currently awaiting correction" style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#c05e00', fontWeight: 600 }}>
                                  <Wrench size={11}/> {s.fix_stats.pending_fix} pending
                                </span>
                                <span title="Total ever sent for correction" style={{ color: '#888' }}>
                                  {s.fix_stats.total_sent_for_fix} sent
                                </span>
                                <span title="Fixed events approved" style={{ display: 'flex', alignItems: 'center', gap: 3, color: '#3a8c3f' }}>
                                  <CheckCircle size={11}/> {s.fix_stats.fixed_approved} approved
                                </span>
                              </div>
                            ) : <span style={{ color: '#ddd' }}>—</span>
                          ) : run?.status === 'completed' ? (
                            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <CheckCircle size={12} color="#3a8c3f"/>
                              <span style={{ color: '#3a8c3f' }}>{run.events_extracted} new</span>
                            </span>
                          ) : run?.status === 'failed' ? (
                            <span style={{ color: '#c0392b', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <XCircle size={12}/> Failed
                            </span>
                          ) : isRunning ? (
                            <span style={{ color: '#3a8c3f' }}>{run?.events_extracted || 0} so far</span>
                          ) : <span style={{ color: '#ddd' }}>—</span>}
                        </td>

                        <td style={{ padding: '0.875rem 1rem' }}>
                          {isFixAgent ? (
                            <ToggleRight size={22} color="#3a8c3f" style={{ opacity: 0.45 }}/>
                          ) : (
                            <button onClick={() => toggleActive(s)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: s.active ? '#3a8c3f' : '#ccc', padding: 0 }}>
                              {s.active ? <ToggleRight size={22}/> : <ToggleLeft size={22}/>}
                            </button>
                          )}
                        </td>

                        <td style={{ padding: '0.875rem 1rem' }}>
                          {isFixAgent ? (
                            <span style={{ fontSize: 11, color: '#ccc', fontStyle: 'italic' }}>auto-triggered</span>
                          ) : (
                            <button onClick={() => triggerRun(s.id)}
                              disabled={isRunning || triggering === s.id || !s.active}
                              style={{ background: 'none', border: `1.5px solid ${isRunning ? '#ddd' : '#3a8c3f'}`, borderRadius: 6, padding: '0.3rem 0.65rem', cursor: isRunning ? 'default' : 'pointer', color: isRunning ? '#ccc' : '#3a8c3f', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                              {isRunning || triggering === s.id ? <Loader size={11} style={{ animation: 'spin 1s linear infinite' }}/> : <Play size={11}/>}
                              {isRunning ? 'Running' : 'Run now'}
                            </button>
                          )}
                        </td>
                        <td style={{ padding: '0.875rem 0.5rem', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <button onClick={() => openPromptDrawer(s)}
                              title="View / edit system prompt"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', padding: 0 }}
                              onMouseEnter={e => (e.currentTarget.style.color = '#3a8c3f')}
                              onMouseLeave={e => (e.currentTarget.style.color = '#bbb')}>
                              <FileText size={15}/>
                            </button>
                            <button onClick={() => deleteSource(s)}
                              title="Delete source"
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ddd', padding: 0 }}
                              onMouseEnter={e => (e.currentTarget.style.color = '#c0392b')}
                              onMouseLeave={e => (e.currentTarget.style.color = '#ddd')}>
                              <Trash2 size={15}/>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {sources.length === 0 && (
                    <tr><td colSpan={7} style={{ padding: '3rem', textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                      No sources yet — add your first one above
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* How to use */}
            <div style={{ marginTop: '1.25rem', background: '#e8f5e9', border: '1px solid #c8e6c9', borderRadius: 8, padding: '1rem 1.25rem' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#2a6b2e', marginBottom: 6 }}>How to connect your agent</div>
              <div style={{ fontSize: 12, color: '#3a8c3f', lineHeight: 1.6 }}>
                Copy the ingest endpoint and paste it into your Claude agent's system prompt:<br/>
                <code style={{ background: 'rgba(0,0,0,0.06)', padding: '2px 6px', borderRadius: 3 }}>
                  "When done, POST your JSON events array to: {APP_URL}/api/ingest/your-source-slug"
                </code>
              </div>
            </div>

            {/* Recent run history */}
            {runs.filter(r => r.status !== 'running').length > 0 && (
              <div style={{ marginTop: '1.5rem' }}>
                <h3 style={{ fontSize: 12, fontWeight: 700, color: '#aaa', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent runs</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {runs.filter(r => r.status !== 'running').slice(0, 5).map(r => (
                    <div key={r.id} style={{ background: 'white', border: '1px solid #eee', borderRadius: 8, padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
                      {r.status === 'completed' ? <CheckCircle size={14} color="#3a8c3f"/> : <XCircle size={14} color="#c0392b"/>}
                      <span style={{ fontWeight: 600, width: 160 }}>{r.source_name}</span>
                      <span style={{ color: '#888' }}>{new Date(r.started_at).toLocaleString()}</span>
                      <span style={{ color: '#3a8c3f', marginLeft: 'auto' }}>{r.events_extracted} extracted</span>
                      <span style={{ color: '#aaa' }}>{r.elapsed_sec}s</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* System prompt drawer */}
      {promptSource && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end', zIndex: 200 }}
          onClick={e => { if (e.target === e.currentTarget) setPromptSource(null); }}>
          <div style={{ width: '100%', maxWidth: 700, background: 'white', display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 32px rgba(0,0,0,0.18)', overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid #eee', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{promptSource.name}</div>
                <div style={{ fontSize: 11, color: '#aaa', fontFamily: 'monospace', marginTop: 2 }}>{promptSource.agent_id}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {promptVersion > 0 && (
                  <span style={{ fontSize: 11, color: '#aaa', background: '#f5f5f5', padding: '2px 8px', borderRadius: 10 }}>v{promptVersion}</span>
                )}
                <button onClick={() => setPromptSource(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#aaa', padding: 4 }}>
                  <X size={18}/>
                </button>
              </div>
            </div>

            {/* Body */}
            <div style={{ flex: 1, padding: '1.25rem 1.5rem', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {promptError && (
                <div style={{ background: '#fdecea', color: '#c0392b', padding: '0.6rem 0.875rem', borderRadius: 6, fontSize: 13, marginBottom: '1rem', flexShrink: 0 }}>
                  {promptError}
                </div>
              )}

              {promptLoading ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#aaa', gap: 8, fontSize: 13 }}>
                  <Loader size={16} style={{ animation: 'spin 1s linear infinite' }}/> Loading system prompt…
                </div>
              ) : (
                <>
                  <label style={{ ...labelStyle, marginBottom: 8 }}>System prompt</label>
                  <textarea
                    value={promptText}
                    onChange={e => setPromptText(e.target.value)}
                    spellCheck={false}
                    style={{
                      flex: 1,
                      resize: 'none',
                      border: '1.5px solid #ddd',
                      borderRadius: 8,
                      padding: '0.75rem',
                      fontSize: 12,
                      fontFamily: 'monospace',
                      lineHeight: 1.6,
                      outline: 'none',
                      color: '#333',
                      overflowY: 'auto',
                    }}
                  />
                  <div style={{ fontSize: 11, color: '#bbb', marginTop: 6, textAlign: 'right', flexShrink: 0 }}>
                    {promptText.length.toLocaleString()} chars
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {!promptLoading && (
              <div style={{ padding: '1rem 1.5rem', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0 }}>
                <button onClick={() => setPromptSource(null)} className="btn-ghost" style={{ fontSize: 14 }}>Close</button>
                <button onClick={savePrompt} disabled={promptSaving} className="btn-primary" style={{ fontSize: 14, minWidth: 110 }}>
                  {promptSaving ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite', marginRight: 6 }}/>Saving…</> : 'Save changes'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add source modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'white', borderRadius: 14, padding: '2rem', width: '100%', maxWidth: 460, boxShadow: '0 8px 40px rgba(0,0,0,0.2)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Add source</h2>
            <p style={{ fontSize: 13, color: '#888', marginBottom: '1.5rem' }}>
              An ingest endpoint will be generated automatically from the name.
            </p>

            {addError && (
              <div style={{ background: '#fdecea', color: '#c0392b', padding: '0.6rem 0.875rem', borderRadius: 6, fontSize: 13, marginBottom: '1rem' }}>
                {addError}
              </div>
            )}

            <label style={labelStyle}>Organization name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Apollo Theatre"
              style={{ ...inputStyle, marginBottom: '0.5rem' }}
              autoFocus
            />
            {/* Preview the slug */}
            {form.name && (
              <div style={{ fontSize: 11, color: '#888', marginBottom: '1rem', fontFamily: 'monospace' }}>
                Endpoint: /api/ingest/{form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}
              </div>
            )}

            <label style={labelStyle}>Agent ID</label>
            <input
              value={form.agent_id}
              onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
              placeholder="agt_… from Anthropic console"
              style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12, marginBottom: '1rem' }}
            />

            <label style={labelStyle}>Fetch frequency</label>
            <select
              value={form.schedule_cron}
              onChange={e => setForm(f => ({ ...f, schedule_cron: e.target.value }))}
              style={{ ...inputStyle, marginBottom: '1.5rem', appearance: 'auto' }}>
              {SCHEDULE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>

            <div style={{ background: '#e8f5e9', borderRadius: 8, padding: '0.75rem 0.875rem', fontSize: 13, color: '#2a6b2e', marginBottom: '1.5rem' }}>
              ✓ Ingest endpoint generated instantly — paste it into your agent's system prompt
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setAddError(''); }} className="btn-ghost" style={{ fontSize: 14 }}>Cancel</button>
              <button onClick={addSource} disabled={!form.name.trim() || !form.agent_id.trim() || adding} className="btn-primary" style={{ fontSize: 14, minWidth: 100 }}>
                {adding ? 'Adding…' : 'Add source'}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

const labelStyle: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: '100%', padding: '0.65rem 0.875rem', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
