'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { ClipboardList, CheckCircle, XCircle, Clock, ArrowRight, Wrench } from 'lucide-react';
import OnboardingTour from '@/components/OnboardingTour';

export default function ReviewerDashboardPage() {
  const { user, token, ready } = useAuth();
  const [data, setData]        = useState<any>(null);
  const [loading, setLoading]  = useState(true);
  const [showTour, setShowTour] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!ready || !token) return;
    fetch('/api/reviewer/dashboard', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setData).finally(() => setLoading(false));
    fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => { if (!d.onboarded) setShowTour(true); });
  }, [ready, token]);

  if (!ready || !user) return null;

  const stats   = data?.personal_stats || {};
  const sources = data?.assigned_sources || [];
  const recent  = data?.recent_activity || [];
  const oldest  = data?.oldest_pending;

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      {showTour && <OnboardingTour role="reviewer" token={token} onDone={() => setShowTour(false)}/>}
      <Sidebar role={user.role} name={user.name} email={user.email} token={token} />

      <main style={{ flex: 1, padding: '2rem', maxWidth: 900 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: '0.25rem' }}>Your dashboard</h1>
        <p style={{ fontSize: 13, color: '#888', marginBottom: '1.5rem' }}>Your personal review stats</p>

        {loading ? <div style={{ color: '#888', fontSize: 14 }}>Loading…</div> : (
          <>
            {data?.pending > 0 ? (
              <div onClick={() => router.push('/reviewer/queue')}
                style={{ background: '#3a8c3f', borderRadius: 10, padding: '1.25rem 1.5rem', marginBottom: '1.5rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ background: 'rgba(255,255,255,0.2)', borderRadius: 8, padding: '0.5rem', display: 'flex' }}>
                    <ClipboardList size={22} color="white"/>
                  </div>
                  <div>
                    <div style={{ color: 'white', fontWeight: 700, fontSize: 16 }}>
                      {data.pending} event{data.pending !== 1 ? 's' : ''} waiting for review
                    </div>
                    {oldest && (
                      <div style={{ color: 'rgba(255,255,255,0.75)', fontSize: 12, marginTop: 2 }}>
                        Oldest from {new Date(oldest.created_at).toLocaleDateString()} · {oldest.source_name}
                      </div>
                    )}
                  </div>
                </div>
                <ArrowRight size={20} color="white"/>
              </div>
            ) : (
              <div style={{ background: '#e8f5e9', borderRadius: 10, padding: '1.25rem 1.5rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: 12 }}>
                <CheckCircle size={22} color="#3a8c3f"/>
                <div style={{ fontSize: 15, fontWeight: 600, color: '#2a6b2e' }}>Queue is clear — all events reviewed!</div>
              </div>
            )}

            {/* Row 1: today's numbers */}
            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1rem' }}>
              <StatCard label="Today approved" value={stats.approved_today || 0} color="#e8f5e9" textColor="#2a6b2e" icon={<CheckCircle size={16} color="#3a8c3f"/>}/>
              <StatCard label="Today rejected" value={stats.rejected_today || 0} color="#fdecea" textColor="#c0392b" icon={<XCircle size={16} color="#c0392b"/>}/>
              <StatCard label="Total reviewed" value={stats.total_reviewed || 0} color="#f8f9fa" textColor="#333" icon={<ClipboardList size={16} color="#666"/>}/>
              <StatCard label="Avg time (sec)"  value={stats.avg_time_sec  || '—'} color="#f8f9fa" textColor="#333" icon={<Clock size={16} color="#666"/>}/>
            </div>

            {/* Row 2: correction stats */}
            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
              <StatCard label="You approved"       value={stats.total_approved || 0}            color="#e8f5e9" textColor="#2a6b2e" icon={<CheckCircle size={16} color="#3a8c3f"/>}/>
              <StatCard label="You rejected"        value={stats.total_rejected || 0}            color="#fdecea" textColor="#c0392b" icon={<XCircle size={16} color="#c0392b"/>}/>
              <StatCard label="Sent for correction" value={stats.total_sent_for_correction || 0} color="#fff8f0" textColor="#c05e00" icon={<Wrench size={16} color="#e67e22"/>}/>
            </div>

            {/* Corrections approved highlight */}
            {(stats.corrections_approved > 0 || stats.total_sent_for_correction > 0) && (
              <div style={{ background: 'white', border: '1px solid #e8e8e8', borderRadius: 10, padding: '1rem 1.25rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ background: '#e8f5e9', borderRadius: 8, padding: '0.5rem', display: 'flex' }}>
                  <CheckCircle size={18} color="#3a8c3f"/>
                </div>
                <div>
                  <span style={{ fontSize: 22, fontWeight: 800, color: '#3a8c3f' }}>{stats.corrections_approved || 0}</span>
                  <span style={{ fontSize: 13, color: '#555', marginLeft: 8 }}>
                    of your {stats.total_sent_for_correction || 0} correction{stats.total_sent_for_correction !== 1 ? 's' : ''} came back and were approved
                  </span>
                </div>
              </div>
            )}

            <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
              {/* Sources — shared queue breakdown */}
              <div className="card">
                <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Queue by source</h3>
                {sources.length === 0
                  ? <p style={{ fontSize: 13, color: '#aaa' }}>No sources</p>
                  : sources.map((s: any) => (
                    <div key={s.id} onClick={() => router.push(`/reviewer/queue?source_id=${s.id}`)}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0', borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</span>
                      <span style={{ background: s.pending_count > 0 ? '#3a8c3f' : '#f0f0f0', color: s.pending_count > 0 ? 'white' : '#aaa', borderRadius: 20, padding: '1px 8px', fontSize: 11, fontWeight: 700 }}>
                        {s.pending_count}
                      </span>
                    </div>
                  ))
                }
              </div>

              {/* Recent activity — personal */}
              <div className="card">
                <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Your recent activity</h3>
                {recent.length === 0
                  ? <p style={{ fontSize: 13, color: '#aaa' }}>No activity yet</p>
                  : recent.slice(0, 8).map((r: any, i: number) => {
                    const meta: Record<string,{icon: React.ReactNode; label:string}> = {
                      approved:            { icon: <CheckCircle size={14} color="#3a8c3f"/>, label: 'Approved'     },
                      rejected:            { icon: <XCircle size={14} color="#c0392b"/>,    label: 'Rejected'     },
                      sent_for_correction: { icon: <Wrench size={14} color="#c05e00"/>,     label: 'Sent for fix' },
                    };
                    const m = meta[r.action] || { icon: <Clock size={14} color="#aaa"/>, label: r.action };
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.5rem 0', borderBottom: '1px solid #f5f5f5' }}>
                        {m.icon}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: r.action === 'approved' ? '#3a8c3f' : r.action === 'rejected' ? '#c0392b' : '#c05e00', flexShrink: 0 }}>{m.label}</span>
                          </div>
                          <div style={{ fontSize: 11, color: '#aaa' }}>{r.source_name}</div>
                        </div>
                        <div style={{ fontSize: 10, color: '#ccc' }}>
                          {new Date(r.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                    );
                  })
                }
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function StatCard({ label, value, color, textColor, icon }: any) {
  return (
    <div style={{ background: color, borderRadius: 8, padding: '1rem', border: '1px solid #e8e8e8' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        {icon}
        <span style={{ fontSize: 11, color: '#888', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      </div>
      <div style={{ fontSize: 26, fontWeight: 800, color: textColor }}>{value}</div>
    </div>
  );
}
