'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { Bot, CheckCircle, XCircle, Edit3, Zap, Clock, AlertCircle } from 'lucide-react';

const GRADE_COLOR: Record<string, { bg: string; fg: string }> = {
  A: { bg: '#e8f5e9', fg: '#2a6b2e' },
  B: { bg: '#e3f2fd', fg: '#1565c0' },
  C: { bg: '#fff8e1', fg: '#c05e00' },
  D: { bg: '#fff3e0', fg: '#e65100' },
  F: { bg: '#fdecea', fg: '#c0392b' },
};

const STATUS_COLOR: Record<string, string> = {
  completed: '#3a8c3f',
  running:   '#1565c0',
  failed:    '#c0392b',
  pending:   '#e67e22',
};

function Bar({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ background: '#eee', borderRadius: 4, height: 6, flex: 1 }}>
      <div style={{ background: color, borderRadius: 4, height: 6, width: `${pct}%`, transition: 'width 0.6s ease' }} />
    </div>
  );
}

function Stat({ label, value, icon, color = '#333' }: { label: string; value: string | number; icon: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, minWidth: 64 }}>
      <div style={{ color }}>{icon}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 10, color: '#999', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>{label}</div>
    </div>
  );
}

function GradeBadge({ grade }: { grade: string | null }) {
  if (!grade) return <span style={{ fontSize: 11, color: '#bbb' }}>N/A</span>;
  const { bg, fg } = GRADE_COLOR[grade] || { bg: '#eee', fg: '#666' };
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 10, background: bg, color: fg, fontWeight: 800, fontSize: 22 }}>
      {grade}
    </span>
  );
}

export default function AgentAnalyticsPage() {
  const { user, token, ready } = useAuth('admin');
  const [sources, setSources]  = useState<any[]>([]);
  const [loading, setLoading]  = useState(true);
  const [days, setDays]        = useState('30');
  const [testEmailTo, setTestEmailTo]       = useState('');
  const [testEmailMsg, setTestEmailMsg]     = useState('');
  const [testEmailSending, setTestEmailSending] = useState(false);

  useEffect(() => {
    if (!ready || !token) return;
    setLoading(true);
    fetch(`/api/admin/agent-analytics?days=${days}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(d => { setSources(Array.isArray(d) ? d : []); })
      .finally(() => setLoading(false));
  }, [ready, token, days]);

  if (!ready || !user) return null;

  const maxTotal      = Math.max(...sources.map(s => s.total), 1);
  const totalEvents   = sources.reduce((s, r) => s + r.total,    0);
  const totalApproved = sources.reduce((s, r) => s + r.approved, 0);
  const totalRejected = sources.reduce((s, r) => s + r.rejected, 0);
  const totalEdited   = sources.reduce((s, r) => s + r.edited,   0);
  const totalPending  = sources.reduce((s, r) => s + r.pending,  0);

  const selectStyle: React.CSSProperties = {
    padding: '0.4rem 0.75rem', border: '1.5px solid #ddd',
    borderRadius: 6, fontSize: 13, outline: 'none', background: 'white',
  };

  async function sendTestEmail() {
    if (!testEmailTo || !token) return;
    setTestEmailSending(true);
    setTestEmailMsg('');
    try {
      const res = await fetch('/api/admin/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to: testEmailTo }),
      });
      const data = await res.json();
      if (res.ok) {
        setTestEmailMsg(`Sent! Resend ID: ${data.resend?.data?.id || 'ok'}`);
      } else {
        setTestEmailMsg(`Error: ${data.error}`);
      }
    } catch (e: any) {
      setTestEmailMsg(`Error: ${e.message}`);
    } finally {
      setTestEmailSending(false);
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role="admin" name={user.name} email={user.email} token={token} />
      <main style={{ flex: 1, padding: '2rem', overflowY: 'auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>Agent analytics</h1>
            <p style={{ fontSize: 13, color: '#888', margin: 0 }}>Per-source AI performance — how well each agent extracts and cleans events</p>
          </div>
          <select value={days} onChange={e => setDays(e.target.value)} style={selectStyle}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">All time (1 yr)</option>
          </select>
        </div>

        {/* Summary cards */}
        {!loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
            {[
              { label: 'Pulled',   val: totalEvents,   color: '#555',    icon: <Zap size={16}/> },
              { label: 'Approved', val: totalApproved, color: '#3a8c3f', icon: <CheckCircle size={16}/> },
              { label: 'Rejected', val: totalRejected, color: '#c0392b', icon: <XCircle size={16}/> },
              { label: 'Edited',   val: totalEdited,   color: '#1565c0', icon: <Edit3 size={16}/> },
              { label: 'Pending',  val: totalPending,  color: '#e67e22', icon: <Clock size={16}/> },
            ].map(({ label, val, color, icon }) => (
              <div key={label} className="card" style={{ textAlign: 'center', padding: '1rem' }}>
                <div style={{ color, marginBottom: 4 }}>{icon}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color }}>{val}</div>
                <div style={{ fontSize: 11, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Grade legend */}
        <div style={{ display: 'flex', gap: 8, marginBottom: '1.25rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#999', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>Grade</span>
          {(['A','B','C','D','F'] as const).map(g => {
            const { bg, fg } = GRADE_COLOR[g];
            const desc: Record<string,string> = { A:'≥85% approved, low edits', B:'≥70%', C:'≥55%', D:'≥40%', F:'<40%' };
            return (
              <span key={g} style={{ background: bg, color: fg, borderRadius: 6, padding: '3px 10px', fontSize: 11, fontWeight: 700 }}>
                {g} <span style={{ fontWeight: 400, opacity: 0.8 }}>— {desc[g]}</span>
              </span>
            );
          })}
        </div>

        {/* Source cards */}
        {loading ? (
          <div style={{ color: '#888', fontSize: 14 }}>Loading…</div>
        ) : sources.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '3rem', color: '#aaa' }}>No sources found</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {sources.map(s => (
              <div key={s.id} className="card" style={{ padding: '1.25rem 1.5rem' }}>

                {/* Top row */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', marginBottom: '1rem' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 10, flexShrink: 0,
                    background: s.active ? '#e8f5e9' : '#f0f0f0',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Bot size={20} color={s.active ? '#3a8c3f' : '#bbb'} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{s.name}</span>
                      {!s.active && (
                        <span style={{ fontSize: 10, background: '#eee', color: '#888', borderRadius: 10, padding: '1px 8px', fontWeight: 600 }}>Inactive</span>
                      )}
                      {s.last_run_status && (
                        <span style={{ fontSize: 10, background: '#f0f0f0', color: STATUS_COLOR[s.last_run_status] || '#888', borderRadius: 10, padding: '1px 8px', fontWeight: 600 }}>
                          Last run: {s.last_run_status}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#bbb', marginTop: 2 }}>
                      {s.agent_id ? `Agent: ${s.agent_id}` : 'No agent assigned'}
                      {s.last_run_at && ` · Last run ${new Date(s.last_run_at).toLocaleDateString()}`}
                      {s.total_runs > 0 && ` · ${s.total_runs} run${s.total_runs !== 1 ? 's' : ''} in period`}
                    </div>
                  </div>

                  <GradeBadge grade={s.grade} />
                </div>

                {/* Stats */}
                <div style={{
                  display: 'flex', gap: '1.5rem', justifyContent: 'space-around',
                  background: '#f8f9fa', borderRadius: 8, padding: '0.875rem', marginBottom: '1rem',
                }}>
                  <Stat label="Pulled"    value={s.total}    icon={<Zap size={14}/>}         color="#555" />
                  <Stat label="Approved"  value={s.approved} icon={<CheckCircle size={14}/>} color="#3a8c3f" />
                  <Stat label="Rejected"  value={s.rejected} icon={<XCircle size={14}/>}     color="#c0392b" />
                  <Stat label="Edited"    value={s.edited}   icon={<Edit3 size={14}/>}        color="#1565c0" />
                  <Stat label="Pending"   value={s.pending}  icon={<Clock size={14}/>}        color="#e67e22" />
                  <Stat
                    label="Approval %"
                    value={s.approval_rate !== null ? `${s.approval_rate}%` : '—'}
                    icon={<AlertCircle size={14}/>}
                    color={
                      s.approval_rate === null ? '#bbb' :
                      s.approval_rate >= 70    ? '#3a8c3f' :
                      s.approval_rate >= 50    ? '#c05e00' : '#c0392b'
                    }
                  />
                </div>

                {/* Progress bars */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 10, color: '#aaa', width: 58, textAlign: 'right', fontWeight: 600 }}>Volume</span>
                    <Bar value={s.total} max={maxTotal} color="#3a8c3f" />
                    <span style={{ fontSize: 10, color: '#aaa', width: 28, textAlign: 'right' }}>{s.total}</span>
                  </div>
                  {s.total > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: '#aaa', width: 58, textAlign: 'right', fontWeight: 600 }}>Approved</span>
                      <Bar value={s.approved} max={s.total} color="#3a8c3f" />
                      <span style={{ fontSize: 10, color: '#aaa', width: 28, textAlign: 'right' }}>
                        {Math.round(s.approved / s.total * 100)}%
                      </span>
                    </div>
                  )}
                  {s.total > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, color: '#aaa', width: 58, textAlign: 'right', fontWeight: 600 }}>Edited</span>
                      <Bar value={s.edited} max={s.total} color="#1565c0" />
                      <span style={{ fontSize: 10, color: '#aaa', width: 28, textAlign: 'right' }}>
                        {Math.round(s.edited / s.total * 100)}%
                      </span>
                    </div>
                  )}
                </div>

                {/* Clean note */}
                {s.approved > 0 && (
                  <div style={{ marginTop: '0.75rem', fontSize: 11, color: '#888' }}>
                    <span style={{ color: '#3a8c3f', fontWeight: 700 }}>{s.clean_approved}</span> of {s.approved} approved events needed no edits
                    {' '}({Math.round(s.clean_approved / s.approved * 100)}% clean)
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Test email panel */}
        <div className="card" style={{ marginTop: '2rem', padding: '1.25rem 1.5rem' }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
            <Zap size={14} color="#3a8c3f" /> Test email delivery
          </h3>
          <p style={{ fontSize: 12, color: '#888', margin: '0 0 0.75rem' }}>
            Send a sample review-notification email to confirm Resend is delivering correctly.
          </p>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="email"
              placeholder="recipient@example.com"
              value={testEmailTo}
              onChange={e => setTestEmailTo(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && sendTestEmail()}
              style={{ flex: 1, padding: '7px 12px', border: '1.5px solid #ddd', borderRadius: 7, fontSize: 13, outline: 'none' }}
            />
            <button
              onClick={sendTestEmail}
              disabled={testEmailSending || !testEmailTo}
              style={{
                padding: '7px 18px', background: '#3a8c3f', color: 'white',
                border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600,
                cursor: 'pointer', opacity: testEmailSending ? 0.6 : 1,
              }}
            >
              {testEmailSending ? 'Sending…' : 'Send test'}
            </button>
          </div>
          {testEmailMsg && (
            <p style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: testEmailMsg.startsWith('Error') ? '#c0392b' : '#3a8c3f' }}>
              {testEmailMsg}
            </p>
          )}
        </div>

      </main>
    </div>
  );
}
