'use client';
import { useEffect, useState } from 'react';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { TrendingUp, CheckCircle, XCircle, Activity, Users } from 'lucide-react';
import OnboardingTour from '@/components/OnboardingTour';

export default function AdminStatsPage() {
  const { user, token, ready } = useAuth('admin');
  const [stats, setStats]       = useState<any>(null);
  const [sources, setSources]   = useState<any[]>([]);
  const [reasons, setReasons]   = useState<any[]>([]);
  const [fields, setFields]     = useState<any[]>([]);
  const [timeline, setTimeline] = useState<any[]>([]);
  const [activity, setActivity] = useState<any>(null);
  const [days, setDays]         = useState('30');
  const [showTour, setShowTour] = useState(false);

  useEffect(() => {
    if (!ready || !token) return;
    const h = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch(`/api/admin/stats?type=stats&days=${days}`, { headers: h }).then(r => r.json()),
      fetch(`/api/admin/stats?type=by-source&days=${days}`, { headers: h }).then(r => r.json()),
      fetch(`/api/admin/stats?type=rejection-reasons&days=${days}`, { headers: h }).then(r => r.json()),
      fetch(`/api/admin/stats?type=field-edits&days=${days}`, { headers: h }).then(r => r.json()),
      fetch(`/api/admin/stats?type=timeline&days=${days}`, { headers: h }).then(r => r.json()),
      fetch('/api/admin/activity?limit=15', { headers: h }).then(r => r.json()),
    ]).then(([s, src, r, f, t, act]) => {
      setStats(s); setSources(src); setReasons(r); setFields(f); setTimeline(t); setActivity(act);
    });
    fetch('/api/users/me', { headers: h }).then(r => r.json()).then(d => { if (!d.onboarded) setShowTour(true); });
  }, [ready, token, days]);

  if (!ready || !user) return null;
  const maxEdits = Math.max(...fields.map(f => f.edits), 1);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      {showTour && <OnboardingTour role="admin" token={token} onDone={() => setShowTour(false)}/>}
      <Sidebar role="admin" name={user.name} email={user.email} token={token} />
      <main style={{ flex: 1, padding: '2rem', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: '1.5rem', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 25, fontWeight: 800 }}>Dashboard</h1>
            <p style={{ fontSize: 13, color: 'var(--gray-mid)', marginTop: 3 }}>Extraction quality and review activity at a glance.</p>
          </div>
          <select value={days} onChange={e => setDays(e.target.value)} className="input"
            style={{ width: 'auto', padding: '0.5rem 0.85rem', fontWeight: 600, cursor: 'pointer' }}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>

        {activity?.today && (
          <div className="animate-rise" style={{ background: 'linear-gradient(180deg, #ecf7ed, #e3f3e5)', border: '1px solid var(--green-200)', borderRadius: 'var(--r-lg)', padding: '1rem 1.35rem', marginBottom: '1.5rem', display: 'flex', gap: '2rem', alignItems: 'center', flexWrap: 'wrap', boxShadow: 'var(--shadow-xs)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 11.5, fontWeight: 800, color: 'var(--green-700)', textTransform: 'uppercase', letterSpacing: 0.8 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--green-500)', boxShadow: '0 0 0 3px rgba(58,140,63,0.18)' }}/>
              Today
            </span>
            <TodayStat label="Extracted" val={activity.today.extracted_today || 0}/>
            <TodayStat label="Approved"  val={activity.today.approved_today  || 0}/>
            <TodayStat label="Rejected"  val={activity.today.rejected_today  || 0} color="#c0392b"/>
            <TodayStat label="Pending"   val={activity.today.pending         || 0} color="#e67e22"/>
          </div>
        )}

        {stats && (
          <div className="stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem', marginBottom: '1.5rem' }}>
            <StatCard label="Extracted"    value={stats.total_extracted || 0} icon={<TrendingUp size={18} color="#3a8c3f"/>} />
            <StatCard label="Approved"     value={stats.total_approved  || 0} icon={<CheckCircle size={18} color="#3a8c3f"/>} color="#e8f5e9" />
            <StatCard label="Rejected"     value={stats.total_rejected  || 0} icon={<XCircle size={18} color="#c0392b"/>}    color="#fdecea" />
            <StatCard label="Approval rate" value={stats.approval_rate !== null && stats.approval_rate !== undefined ? `${stats.approval_rate}%` : '—'} icon={<Activity size={18} color="#3a8c3f"/>} color="#e8f5e9" />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', marginBottom: '1.25rem' }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Approval rate by source</h3>
            {sources.map(s => (
              <div key={s.id} style={{ marginBottom: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{s.name}</span>
                  <span style={{ color: '#888' }}>
                    {s.approved||0}/{s.total||0} approved
                    {s.approval_rate !== null && s.approval_rate !== undefined ? ` · ${s.approval_rate}%` : ''}
                  </span>
                </div>
                <div style={{ background: '#eee', borderRadius: 4, height: 6 }}>
                  <div style={{ background: '#3a8c3f', borderRadius: 4, height: 6, width: `${s.approval_rate||0}%`, transition: 'width 0.5s' }}/>
                </div>
              </div>
            ))}
            {!sources.length && <p style={{ fontSize: 12, color: '#aaa' }}>No data yet</p>}
          </div>

          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Rejection reasons</h3>
            {reasons.slice(0,8).map((r:any) => (
              <div key={r.reason} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#c0392b', flexShrink: 0 }}/>
                <span style={{ fontSize: 12, flex: 1 }}>{r.reason.replace(/_/g,' ')}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#c0392b' }}>{r.count}</span>
              </div>
            ))}
            {!reasons.length && <p style={{ fontSize: 12, color: '#aaa' }}>No rejections yet</p>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', marginBottom: '1.25rem' }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Most-edited fields <span style={{ fontSize: 11, fontWeight: 400, color: '#888' }}>(extraction accuracy)</span></h3>
            {fields.slice(0,7).map((f:any) => (
              <div key={f.field_name} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 11, width: 150, color: '#444', fontFamily: 'monospace', flexShrink: 0 }}>{f.field_name}</span>
                <div style={{ flex: 1, background: '#eee', borderRadius: 4, height: 7 }}>
                  <div style={{ background: '#e67e22', borderRadius: 4, height: 7, width: `${(f.edits/maxEdits)*100}%` }}/>
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#e67e22', width: 24, textAlign: 'right' }}>{f.edits}</span>
              </div>
            ))}
            {!fields.length && <p style={{ fontSize: 12, color: '#aaa' }}>No edits yet</p>}
          </div>

          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: 6 }}><Users size={14}/> Reviewer activity</h3>
            {(activity?.reviewer_stats||[]).map((u:any,i:number) => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0.5rem 0', borderBottom: '1px solid #f5f5f5' }}>
                <div style={{ width: 24, height: 24, borderRadius: '50%', background: i===0?'#3a8c3f':'#e8f5e9', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: i===0?'white':'#3a8c3f', flexShrink: 0 }}>
                  {u.full_name?.[0] || '?'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.full_name}</div>
                  <div style={{ fontSize: 10, color: '#aaa' }}>{u.approved||0} approved · {u.rejected||0} rejected{u.avg_time_sec?` · ${u.avg_time_sec}s avg`:''}</div>
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#3a8c3f' }}>{u.approved_today||0} today</div>
              </div>
            ))}
            {!activity?.reviewer_stats?.length && <p style={{ fontSize: 12, color: '#aaa' }}>No reviewer activity</p>}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem' }}>Events over time</h3>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 70 }}>
              {timeline.slice(-30).map((t:any,i:number) => {
                const maxVal = Math.max(...timeline.map((x:any)=>x.extracted),1);
                return (
                  <div key={i} title={`${t.date}: ${t.extracted} extracted, ${t.approved} approved`}
                    style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1, cursor: 'default' }}>
                    <div style={{ width: '100%', background: '#3a8c3f', borderRadius: '2px 2px 0 0', height: `${(t.approved/maxVal)*60}px`, minHeight: t.approved>0?2:0 }}/>
                    <div style={{ width: '100%', background: '#c8e6c9', height: `${((t.extracted-t.approved)/maxVal)*60}px`, minHeight: (t.extracted-t.approved)>0?2:0 }}/>
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 10, color: '#888' }}>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#3a8c3f', borderRadius: 2, marginRight: 3 }}/>Approved</span>
              <span><span style={{ display: 'inline-block', width: 8, height: 8, background: '#c8e6c9', borderRadius: 2, marginRight: 3 }}/>Extracted</span>
            </div>
          </div>

          <div className="card">
            <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: 6 }}><Activity size={14}/> Live activity</h3>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {(activity?.recent_actions||[]).slice(0,12).map((a:any,i:number) => {
                const actionMeta: Record<string,{icon:string;label:string;color:string}> = {
                  approved:            { icon:'✓', label:'Approved',         color:'#3a8c3f' },
                  rejected:            { icon:'✗', label:'Rejected',         color:'#c0392b' },
                  sent_for_correction: { icon:'↩', label:'Sent for fix',     color:'#c05e00' },
                };
                const meta = actionMeta[a.action] || { icon:'·', label: a.action, color:'#888' };
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.4rem 0', borderBottom: '1px solid #f5f5f5', fontSize: 12 }}>
                    <span style={{ fontSize: 13, color: meta.color, fontWeight: 700, width: 14, textAlign: 'center', flexShrink: 0 }}>{meta.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.event_title}</span>
                        <span style={{ fontSize: 10, fontWeight: 700, color: meta.color, flexShrink: 0 }}>{meta.label}</span>
                      </div>
                      <span style={{ fontSize: 10, color: '#aaa' }}>{a.reviewer_name} · {a.source_name}</span>
                    </div>
                    <span style={{ fontSize: 10, color: '#ccc', flexShrink: 0 }}>
                      {new Date(a.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
                    </span>
                  </div>
                );
              })}
              {!activity?.recent_actions?.length && <p style={{ fontSize: 12, color: '#aaa' }}>No activity yet</p>}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function TodayStat({ label, val, color='#2a6b2e' }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
      <span className="tnum" style={{ fontSize: 22, fontWeight: 800, color, letterSpacing: '-0.02em' }}>{val}</span>
      <span style={{ fontSize: 11.5, color: 'var(--green-700)', fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function StatCard({ label, value, icon, color='#f1f5f1' }: any) {
  return (
    <div className="card card-hover" style={{ padding: '1.25rem 1.35rem', display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{
        width: 46, height: 46, borderRadius: 13, flexShrink: 0,
        background: color, display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: 'inset 0 0 0 1px rgba(20,45,25,0.04)',
      }}>{icon}</div>
      <div style={{ minWidth: 0 }}>
        <div className="tnum" style={{ fontSize: 27, fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.02em' }}>{value}</div>
        <div style={{ fontSize: 10.5, color: 'var(--gray-mid)', textTransform: 'uppercase', letterSpacing: 0.7, fontWeight: 700, marginTop: 3 }}>{label}</div>
      </div>
    </div>
  );
}
