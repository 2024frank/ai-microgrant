'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { Clock, Globe, Calendar, ArrowUpDown, Filter } from 'lucide-react';
import { formatDateTime } from '@/lib/timezone';

const GEO_COLORS: Record<string,string> = {
  hyper_local: '#e8f5e9|#2a6b2e', city_wide: '#e3f2fd|#1565c0',
  county: '#fff3e0|#c05e00', regional: '#f3e5f5|#7b1fa2',
};
const GEO_LABELS: Record<string,string> = {
  hyper_local:'Hyper-local', city_wide:'City-wide', county:'County', regional:'Regional',
};
const SORT_OPTIONS = [
  { value: 'ingested_asc',    label: 'Ingested: oldest first'  },
  { value: 'ingested_desc',   label: 'Ingested: newest first'  },
  { value: 'event_date_asc',  label: 'Event date: soonest first' },
  { value: 'event_date_desc', label: 'Event date: latest first' },
];

export default function ReviewerQueuePage() {
  const { user, token, ready } = useAuth();
  const [events, setEvents]    = useState<any[]>([]);
  const [sources, setSources]  = useState<{id:number;name:string}[]>([]);
  const [total, setTotal]      = useState(0);
  const [loading, setLoading]  = useState(true);
  const [page, setPage]        = useState(0);
  const [sort, setSort]        = useState('ingested_asc');
  const [sourceId, setSourceId] = useState('');
  const [newEventsToast, setNewEventsToast] = useState(false);
  const lastTotalRef = useRef<number | null>(null);
  const pollRef      = useRef<NodeJS.Timeout | null>(null);
  const router = useRouter();

  const loadQueue = useCallback(() => {
    if (!token) return;
    setLoading(true);
    const qs = new URLSearchParams({
      page:  String(page),
      limit: '20',
      sort,
      ...(sourceId ? { source_id: sourceId } : {}),
    });
    fetch(`/api/review/queue?${qs}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        setEvents(d.events || []);
        setTotal(d.total  || 0);
        if (d.sources?.length) setSources(d.sources);
      })
      .finally(() => setLoading(false));
  }, [token, page, sort, sourceId]);

  useEffect(() => {
    if (!ready || !token) return;
    loadQueue();
  }, [ready, token, loadQueue]);

  // Reset to page 0 when filters change
  useEffect(() => { setPage(0); }, [sort, sourceId]);

  // Poll for new events every 10s — show toast if count increases
  useEffect(() => {
    if (!ready || !token) return;
    const check = () => {
      fetch(`/api/review/queue?limit=1`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
          const newTotal = d.total || 0;
          if (lastTotalRef.current !== null && newTotal > lastTotalRef.current) {
            setNewEventsToast(true);
          }
          lastTotalRef.current = newTotal;
        }).catch(() => {});
    };
    check();
    pollRef.current = setInterval(check, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [ready, token]); // eslint-disable-line

  if (!ready || !user) return null;

  function refreshQueue() {
    setNewEventsToast(false);
    lastTotalRef.current = null;
    loadQueue();
  }

  function formatEventDate(sessions: any) {
    try {
      const s = typeof sessions === 'string' ? JSON.parse(sessions) : sessions;
      if (!s?.[0]?.startTime) return '—';
      return formatDateTime(s[0].startTime, { short: true, dateOnly: true });
    } catch { return '—'; }
  }

  const selectStyle: React.CSSProperties = {
    border: '1px solid #dde', borderRadius: 7, padding: '6px 10px',
    fontSize: 13, background: 'white', color: '#333', cursor: 'pointer',
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token} />
      {newEventsToast && (
        <div style={{ position: 'fixed', top: 20, left: '50%', transform: 'translateX(-50%)', background: '#3a8c3f', color: 'white', padding: '0.75rem 1.25rem', borderRadius: 8, fontSize: 13, fontWeight: 600, zIndex: 999, boxShadow: '0 4px 16px rgba(0,0,0,0.2)', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer' }}
          onClick={refreshQueue}>
          🆕 New events arrived — click to refresh
        </div>
      )}
      <main style={{ flex: 1, padding: '2rem' }}>

        {/* Header */}
        <div style={{ marginBottom: '1.25rem' }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Review queue</h1>
          <p style={{ fontSize: 13, color: '#888' }}>{total} event{total!==1?'s':''} pending review</p>
        </div>

        {/* Filter / sort bar */}
        <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:'1.25rem', flexWrap:'wrap' }}>
          {/* Source filter */}
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <Filter size={13} color="#888"/>
            <select value={sourceId} onChange={e => setSourceId(e.target.value)} style={selectStyle}>
              <option value="">All sources</option>
              {sources.map(s => (
                <option key={s.id} value={String(s.id)}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Sort */}
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <ArrowUpDown size={13} color="#888"/>
            <select value={sort} onChange={e => setSort(e.target.value)} style={selectStyle}>
              {SORT_OPTIONS.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Active filter chip */}
          {sourceId && (
            <button onClick={() => setSourceId('')}
              style={{ display:'flex', alignItems:'center', gap:4, background:'#e8f5e9', color:'#3a8c3f', border:'none', borderRadius:20, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer' }}>
              {sources.find(s=>String(s.id)===sourceId)?.name || 'Source'} ✕
            </button>
          )}
        </div>

        {/* Event list */}
        {loading ? (
          <div style={{ color:'#888', fontSize:14 }}>Loading…</div>
        ) : events.length === 0 ? (
          <div className="card" style={{ textAlign:'center', padding:'3rem', color:'#888' }}>
            <div style={{ fontSize:36, marginBottom:12 }}>✓</div>
            <div style={{ fontSize:16, fontWeight:600 }}>
              {sourceId ? 'No pending events for this source' : 'Queue is empty'}
            </div>
            <div style={{ fontSize:13, marginTop:4 }}>
              {sourceId ? <button onClick={() => setSourceId('')} style={{ color:'#3a8c3f', background:'none', border:'none', cursor:'pointer', fontSize:13 }}>Clear filter</button> : 'All events reviewed'}
            </div>
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {events.map(ev => {
              const [bg,fg] = (GEO_COLORS[ev.geo_scope]||'#f0f0f0|#555').split('|');
              return (
                <div key={ev.id} onClick={() => router.push(`/reviewer/events/${ev.id}`)}
                  className="card"
                  style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:'1rem', padding:'1rem 1.25rem' }}
                  onMouseEnter={e=>(e.currentTarget.style.boxShadow='0 2px 12px rgba(58,140,63,0.15)')}
                  onMouseLeave={e=>(e.currentTarget.style.boxShadow='none')}>
                  <div style={{ width:36, height:36, borderRadius:8, background:'#e8f5e9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color:'#3a8c3f', flexShrink:0 }}>
                    {ev.source_name?.[0] || '?'}
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2 }}>
                      <span style={{ fontSize:14, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ev.title}</span>
                      {ev.geo_scope && (
                        <span style={{ fontSize:10, padding:'1px 8px', borderRadius:20, background:bg, color:fg, fontWeight:600, flexShrink:0 }}>
                          {GEO_LABELS[ev.geo_scope]}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize:12, color:'#888', display:'flex', gap:12, flexWrap:'wrap' }}>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Globe size={11}/> {ev.source_name}</span>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Calendar size={11}/> {formatEventDate(ev.sessions)}</span>
                      <span style={{ display:'flex', alignItems:'center', gap:3 }}><Clock size={11}/> added {new Date(ev.created_at).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ fontSize:11, color:'#bbb' }}>→</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {total > 20 && (
          <div style={{ display:'flex', gap:8, marginTop:'1.5rem', justifyContent:'center', alignItems:'center' }}>
            <button onClick={() => setPage(p=>Math.max(0,p-1))} disabled={page===0} className="btn-ghost" style={{ fontSize:12 }}>← Prev</button>
            <span style={{ fontSize:13, color:'#888', padding:'0.4rem 0.5rem' }}>Page {page+1} of {Math.ceil(total/20)}</span>
            <button onClick={() => setPage(p=>p+1)} disabled={(page+1)*20>=total} className="btn-ghost" style={{ fontSize:12 }}>Next →</button>
          </div>
        )}
      </main>
    </div>
  );
}
