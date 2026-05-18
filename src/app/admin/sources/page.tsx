'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { Plus, Play, ToggleLeft, ToggleRight, CheckCircle, XCircle, Loader } from 'lucide-react';

const SCHEDULE_OPTIONS = [
  { label: 'Every hour',    value: '0 * * * *'   },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Daily (6am)',   value: '0 6 * * *'   },
  { label: 'Daily (noon)',  value: '0 12 * * *'  },
  { label: 'Weekly',        value: '0 6 * * 1'   },
];

export default function SourcesPage() {
  const { user, token, ready, getFreshToken } = useAuth('admin');
  const [sources, setSources]       = useState<any[]>([]);
  const [runs, setRuns]             = useState<any[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [form, setForm]             = useState({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
  const [adding, setAdding]         = useState(false);
  const [error, setError]           = useState('');
  const [triggering, setTriggering] = useState<number | null>(null);
  const [toast, setToast]           = useState('');
  const pollRef                     = useRef<NodeJS.Timeout | null>(null);

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
          pollRef.current = setTimeout(loadRuns, 2000);
        } else {
          loadSources();
        }
      })
      .catch(() => {});
  }, [token, h, loadSources]);

  useEffect(() => {
    if (!ready || !token) return;
    loadSources();
    loadRuns();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); };
  }, [ready, token]); // eslint-disable-line

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 3000); }

  async function addSource() {
    setAdding(true); setError('');
    const controller = new AbortController();
    const tid = setTimeout(() => { controller.abort(); setAdding(false); setError('Request timed out — please try again'); }, 12000);
    let res: Response;
    try {
      const freshToken = await getFreshToken();
      res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify(form),
        signal: controller.signal,
      });
      clearTimeout(tid);
    } catch (err: any) {
      clearTimeout(tid);
      if (err.name !== 'AbortError') {
        setError(`Error: ${err.message}`);
        setAdding(false);
      }
      return;
    }
    const data = await res.json();
    if (!res.ok) { setError(data.error || 'Failed to add source'); setAdding(false); return; }
    const sourceId = data.id;
    setShowAdd(false);
    setForm({ name: '', agent_id: '', schedule_cron: '0 6 * * *' });
    setAdding(false);
    loadSources();
    showToast(`${data.name} added — starting first fetch…`);
    // Trigger first fetch from frontend — avoids Vercel timeout in API route
    setTimeout(async () => {
      await fetch(`/api/agent/trigger/${sourceId}`, { method: 'POST', headers: h() });
      setTimeout(loadRuns, 500);
    }, 500);
  }

  async function triggerRun(sourceId: number) {
    setTriggering(sourceId);
    try {
      const res  = await fetch(`/api/agent/trigger/${sourceId}`, { method: 'POST', headers: h() });
      const data = await res.json();
      if (!res.ok) {
        showToast(`Error: ${data.error || 'Failed to start run'}`);
      } else {
        showToast(`Agent started for ${data.source} — fetching events…`);
        setTimeout(loadRuns, 1000);
      }
    } catch (err: any) {
      showToast(`Error: ${err.message}`);
    } finally {
      setTriggering(null);
    }
  }

  async function toggleActive(source: any) {
    await fetch(`/api/sources/${source.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...h() },
      body: JSON.stringify({ active: source.active ? 0 : 1 }),
    });
    loadSources();
  }

  if (!ready || !user) return null;

  const latestRunBySource: Record<number, any> = {};
  for (const r of runs) {
    if (!latestRunBySource[r.source_id]) latestRunBySource[r.source_id] = r;
  }
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
            <p style={{ fontSize: 13, color: '#888' }}>One Claude agent per source org</p>
          </div>
          <button onClick={() => setShowAdd(true)} className="btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <Plus size={15}/> Add source
          </button>
        </div>

        {/* Live run banner */}
        {activeRuns.length > 0 && (
          <div style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Loader size={16} color="#3a8c3f" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}/>
            <div style={{ flex: 1 }}>
              {activeRuns.map(r => (
                <div key={r.id} style={{ fontSize: 13 }}>
                  <strong>{r.source_name}</strong> is fetching…
                  <span style={{ color: '#2a6b2e', marginLeft: 8 }}>
                    {r.events_extracted} extracted · {r.events_skipped_dup} dupes · {r.elapsed_sec}s
                  </span>
                </div>
              ))}
            </div>
            <span style={{ fontSize: 11, color: '#888' }}>Live · updates every 2s</span>
          </div>
        )}

        {loading ? (
          <div style={{ color: '#888', fontSize: 14, padding: '3rem', textAlign: 'center' }}>Loading sources…</div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa', borderBottom: '1px solid #eee' }}>
                  {['Source','Agent ID','Schedule','Last run','Result','Approval %','Active',''].map(h => (
                    <th key={h} style={{ padding: '0.75rem 1rem', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sources.map(s => {
                  const run       = latestRunBySource[s.id];
                  const isRunning = run?.status === 'running';
                  const approvalPct = s.total_events > 0
                    ? Math.round((s.total_approved / s.total_events) * 100) : null;

                  return (
                    <tr key={s.id} style={{ borderBottom: '1px solid #f0f0f0' }}>
                      <td style={{ padding: '0.875rem 1rem', fontWeight: 600 }}>{s.name}</td>
                      <td style={{ padding: '0.875rem 1rem', fontFamily: 'monospace', fontSize: 11, color: '#999' }}>
                        {s.agent_id?.slice(0, 16)}…
                      </td>
                      <td style={{ padding: '0.875rem 1rem', color: '#666', fontSize: 12 }}>
                        {SCHEDULE_OPTIONS.find(o => o.value === s.schedule_cron)?.label || s.schedule_cron}
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
                        {isRunning ? (
                          <span style={{ color: '#3a8c3f' }}>{run.events_extracted} so far</span>
                        ) : run?.status === 'completed' ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <CheckCircle size={12} color="#3a8c3f"/>
                            <span style={{ color: '#3a8c3f' }}>{run.events_extracted} new</span>
                            {run.events_skipped_dup > 0 && <span style={{ color: '#aaa' }}>· {run.events_skipped_dup} dupes</span>}
                          </span>
                        ) : run?.status === 'failed' ? (
                          <span style={{ color: '#c0392b', display: 'flex', alignItems: 'center', gap: 4 }}>
                            <XCircle size={12}/> Failed
                          </span>
                        ) : <span style={{ color: '#ddd' }}>—</span>}
                      </td>
                      <td style={{ padding: '0.875rem 1rem' }}>
                        {approvalPct !== null
                          ? <span style={{ fontWeight: 600, color: approvalPct >= 70 ? '#3a8c3f' : '#e67e22' }}>{approvalPct}%</span>
                          : <span style={{ color: '#ddd' }}>—</span>}
                      </td>
                      <td style={{ padding: '0.875rem 1rem' }}>
                        <button onClick={() => toggleActive(s)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: s.active ? '#3a8c3f' : '#ccc', padding: 0 }}>
                          {s.active ? <ToggleRight size={22}/> : <ToggleLeft size={22}/>}
                        </button>
                      </td>
                      <td style={{ padding: '0.875rem 1rem' }}>
                        <button onClick={() => triggerRun(s.id)}
                          disabled={isRunning || triggering === s.id || !s.active}
                          style={{ background: 'none', border: `1.5px solid ${isRunning ? '#ddd' : '#3a8c3f'}`, borderRadius: 6, padding: '0.3rem 0.65rem', cursor: isRunning ? 'default' : 'pointer', color: isRunning ? '#ccc' : '#3a8c3f', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {isRunning || triggering === s.id ? <Loader size={11} style={{ animation: 'spin 1s linear infinite' }}/> : <Play size={11}/>}
                          {isRunning ? 'Running' : 'Run now'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {sources.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '3rem', textAlign: 'center', color: '#aaa', fontSize: 13 }}>
                    No sources yet — add your first one above
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Recent run history */}
        {runs.filter(r => r.status !== 'running').length > 0 && (
          <div style={{ marginTop: '1.5rem' }}>
            <h3 style={{ fontSize: 13, fontWeight: 700, color: '#888', marginBottom: '0.75rem', textTransform: 'uppercase', letterSpacing: 0.5 }}>Recent runs</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {runs.filter(r => r.status !== 'running').slice(0, 5).map(r => (
                <div key={r.id} style={{ background: 'white', border: '1px solid #eee', borderRadius: 8, padding: '0.75rem 1rem', display: 'flex', alignItems: 'center', gap: 12, fontSize: 12 }}>
                  {r.status === 'completed' ? <CheckCircle size={14} color="#3a8c3f"/> : <XCircle size={14} color="#c0392b"/>}
                  <span style={{ fontWeight: 600, width: 160 }}>{r.source_name}</span>
                  <span style={{ color: '#888' }}>{new Date(r.started_at).toLocaleString()}</span>
                  <span style={{ color: '#3a8c3f', marginLeft: 'auto' }}>{r.events_extracted} extracted</span>
                  <span style={{ color: '#aaa' }}>{r.events_skipped_dup} dupes · {r.elapsed_sec}s</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Add source modal */}
      {showAdd && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <div style={{ background: 'white', borderRadius: 14, padding: '2rem', width: '100%', maxWidth: 440, boxShadow: '0 8px 40px rgba(0,0,0,0.2)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Add source</h2>
            <p style={{ fontSize: 13, color: '#888', marginBottom: '1.5rem' }}>
              Each source needs its own Claude agent. All agents share the same environment and vault.
            </p>

            {error && (
              <div style={{ background: '#fdecea', color: '#c0392b', padding: '0.6rem 0.875rem', borderRadius: 6, fontSize: 13, marginBottom: '1rem' }}>
                {error}
              </div>
            )}

            <label style={labelStyle}>Organization name</label>
            <input
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="e.g. Apollo Theatre"
              style={{ ...inputStyle, marginBottom: '1rem' }}
              autoFocus
            />

            <label style={labelStyle}>Agent ID</label>
            <input
              value={form.agent_id}
              onChange={e => setForm(f => ({ ...f, agent_id: e.target.value }))}
              placeholder="From Anthropic console (agt_…)"
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
              ✓ First fetch starts immediately after adding.
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button onClick={() => { setShowAdd(false); setError(''); }} className="btn-ghost" style={{ fontSize: 14 }}>
                Cancel
              </button>
              <button
                onClick={addSource}
                disabled={!form.name.trim() || !form.agent_id.trim() || adding}
                className="btn-primary"
                style={{ fontSize: 14, minWidth: 100 }}>
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
