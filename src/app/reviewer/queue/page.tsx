'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { useAuth } from '@/hooks/useAuth';
import { Clock, Globe, Calendar, ArrowUpDown, Filter, RotateCcw, X, Wrench, CheckSquare, Square, CheckCheck } from 'lucide-react';

import { formatDateTime } from '@/lib/timezone';
import EventTypeBadge from '@/components/EventTypeBadge';

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

const REASON_CODES = [
  { code: 'wrong_audience',           label: 'Wrong audience' },
  { code: 'bad_date_parse',           label: 'Bad date/time' },
  { code: 'duplicate_missed',         label: 'Duplicate' },
  { code: 'description_hallucinated', label: 'Hallucinated description' },
  { code: 'missing_fields',           label: 'Missing fields' },
  { code: 'wrong_geo_scope',          label: 'Wrong geo scope' },
  { code: 'not_public_event',         label: 'Not public' },
  { code: 'wrong_post_type',          label: 'Wrong post type' },
  { code: 'bad_location',             label: 'Bad location' },
  { code: 'other',                    label: 'Other' },
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
  const [sendBackModal, setSendBackModal]   = useState<{ eventId: number; title: string } | null>(null);
  const [correctionNotes, setCorrectionNotes] = useState('');
  const [sendingBack, setSendingBack]         = useState(false);

  // Bulk select state
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkRejectModal, setBulkRejectModal] = useState(false);
  const [bulkRejectReasons, setBulkRejectReasons] = useState<string[]>(['other']);
  const [bulkRejectNote, setBulkRejectNote] = useState('');
  const [bulkProcessing, setBulkProcessing] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ ok: number; failed: number } | null>(null);

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
        setSelected(new Set());
      })
      .finally(() => setLoading(false));
  }, [token, page, sort, sourceId]);

  useEffect(() => {
    if (!ready || !token) return;
    loadQueue();
  }, [ready, token, loadQueue]);

  useEffect(() => { setPage(0); }, [sort, sourceId]);

  useEffect(() => {
    if (!ready || !token) return;
    const check = () => {
      fetch(`/api/review/queue?limit=1`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => {
          const newTotal = d.total || 0;
          if (lastTotalRef.current !== null && newTotal > lastTotalRef.current) setNewEventsToast(true);
          lastTotalRef.current = newTotal;
        }).catch(() => {});
    };
    check();
    pollRef.current = setInterval(check, 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [ready, token]);

  if (!ready || !user) return null;

  function refreshQueue() {
    setNewEventsToast(false);
    lastTotalRef.current = null;
    loadQueue();
  }

  const allSelected = events.length > 0 && events.every(ev => selected.has(ev.id));
  const someSelected = selected.size > 0;

  function toggleSelectAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(events.map(ev => ev.id)));
    }
  }

  function toggleSelect(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function bulkApprove() {
    if (!token || selected.size === 0) return;
    setBulkProcessing(true);
    setBulkResult(null);
    const ids = Array.from(selected);
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/review/events/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'approve', edits: {}, time_spent_sec: 0 }),
      }).then(r => r.ok).catch(() => false)
    ));
    const ok = results.filter(Boolean).length;
    setBulkResult({ ok, failed: ids.length - ok });
    setBulkProcessing(false);
    loadQueue();
  }

  async function bulkReject() {
    if (!token || selected.size === 0 || bulkRejectReasons.length === 0) return;
    setBulkProcessing(true);
    const ids = Array.from(selected);
    const results = await Promise.all(ids.map(id =>
      fetch(`/api/review/events/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'reject', edits: { reason_codes: bulkRejectReasons, reviewer_note: bulkRejectNote }, time_spent_sec: 0 }),
      }).then(r => r.ok).catch(() => false)
    ));
    const ok = results.filter(Boolean).length;
    setBulkResult({ ok, failed: ids.length - ok });
    setBulkProcessing(false);
    setBulkRejectModal(false);
    setBulkRejectNote('');
    setBulkRejectReasons(['other']);
    loadQueue();
  }

  async function submitSendBack() {
    if (!token || !sendBackModal || !correctionNotes.trim()) return;
    setSendingBack(true);
    try {
      const res = await fetch(`/api/review/events/${sendBackModal.eventId}/send-for-correction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ correction_notes: correctionNotes }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSendBackModal(null);
      setCorrectionNotes('');
      loadQueue();
    } catch (err: any) {
      alert(`Failed: ${err.message}`);
    } finally {
      setSendingBack(false);
    }
  }

  function formatEventDate(sessions: any) {
    try {
      const s = typeof sessions === 'string' ? JSON.parse(sessions) : sessions;
      if (!s?.[0]?.startTime) return '—';
      return formatDateTime(s[0].startTime, { short: true, dateOnly: true });
    } catch { return '—'; }
  }

  const selectStyle: React.CSSProperties = {
    border: '1px solid var(--gray-300)', borderRadius: 'var(--r-sm)', padding: '7px 12px',
    fontSize: 13, background: 'var(--surface)', color: 'var(--gray-dark)', cursor: 'pointer',
    outline: 'none', fontWeight: 500, boxShadow: 'var(--shadow-xs)',
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token} />

      {newEventsToast && (
        <div style={{ position:'fixed', top:20, left:'50%', transform:'translateX(-50%)', background:'#3a8c3f', color:'white', padding:'0.75rem 1.25rem', borderRadius:8, fontSize:13, fontWeight:600, zIndex:999, boxShadow:'0 4px 16px rgba(0,0,0,0.2)', display:'flex', alignItems:'center', gap:12, cursor:'pointer' }}
          onClick={refreshQueue}>
          🆕 New events arrived — click to refresh
        </div>
      )}

      <main className="page-main">

        {/* Header */}
        <div style={{ marginBottom:'1.4rem' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <h1 style={{ fontSize:25, fontWeight:800 }}>Review queue</h1>
            {total > 0 && (
              <span className="tnum" style={{ display:'inline-flex', alignItems:'center', background:'var(--green-100)', color:'var(--green-700)', fontWeight:700, fontSize:13, padding:'2px 11px', borderRadius:999 }}>
                {total}
              </span>
            )}
          </div>
          <p style={{ fontSize:13, color:'var(--gray-mid)', marginTop:3 }}>
            {total} event{total!==1?'s':''} awaiting review across all sources.
          </p>
        </div>

        {/* Filter / sort bar */}
        <div style={{ display:'flex', gap:10, alignItems:'center', marginBottom:'1.25rem', flexWrap:'wrap' }}>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <Filter size={13} color="#888"/>
            <select value={sourceId} onChange={e => setSourceId(e.target.value)} style={selectStyle}>
              <option value="">All sources</option>
              {sources.map(s => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
            </select>
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:6 }}>
            <ArrowUpDown size={13} color="#888"/>
            <select value={sort} onChange={e => setSort(e.target.value)} style={selectStyle}>
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {sourceId && (
            <button onClick={() => setSourceId('')}
              style={{ display:'flex', alignItems:'center', gap:4, background:'#e8f5e9', color:'#3a8c3f', border:'none', borderRadius:20, padding:'4px 10px', fontSize:11, fontWeight:700, cursor:'pointer' }}>
              {sources.find(s=>String(s.id)===sourceId)?.name || 'Source'} ✕
            </button>
          )}
        </div>

        {/* Bulk action bar */}
        {someSelected && (
          <div style={{ display:'flex', alignItems:'center', gap:10, background:'#1a1a2e', color:'white', borderRadius:10, padding:'10px 16px', marginBottom:'1rem', flexWrap:'wrap' }}>
            <span style={{ fontSize:13, fontWeight:600 }}>{selected.size} selected</span>
            <button onClick={() => setSelected(new Set())}
              style={{ background:'rgba(255,255,255,0.1)', border:'none', color:'white', borderRadius:6, padding:'4px 10px', fontSize:12, cursor:'pointer' }}>
              Clear
            </button>
            <div style={{ flex:1 }}/>
            <button
              onClick={bulkApprove}
              disabled={bulkProcessing}
              style={{ background:'#3a8c3f', border:'none', color:'white', borderRadius:7, padding:'7px 18px', fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:6, opacity: bulkProcessing ? 0.6 : 1 }}>
              <CheckCheck size={14}/> {bulkProcessing ? 'Processing…' : `Approve ${selected.size}`}
            </button>
            <button
              onClick={() => setBulkRejectModal(true)}
              disabled={bulkProcessing}
              style={{ background:'#c0392b', border:'none', color:'white', borderRadius:7, padding:'7px 18px', fontSize:13, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:6, opacity: bulkProcessing ? 0.6 : 1 }}>
              <X size={14}/> Reject {selected.size}
            </button>
          </div>
        )}

        {/* Bulk result toast */}
        {bulkResult && (
          <div style={{ background: bulkResult.failed ? '#fff3e0' : '#e8f5e9', border:`1px solid ${bulkResult.failed ? '#c05e00' : '#3a8c3f'}`, borderRadius:8, padding:'10px 16px', marginBottom:'1rem', fontSize:13, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
            <span style={{ color: bulkResult.failed ? '#c05e00' : '#2a6b2e', fontWeight:600 }}>
              {bulkResult.ok} succeeded{bulkResult.failed > 0 ? `, ${bulkResult.failed} failed` : ''}
            </span>
            <button onClick={() => setBulkResult(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#999' }}><X size={13}/></button>
          </div>
        )}

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
            {/* Select all row */}
            <div style={{ display:'flex', alignItems:'center', gap:10, padding:'4px 6px' }}>
              <button onClick={toggleSelectAll} style={{ background:'none', border:'none', cursor:'pointer', color:'#3a8c3f', display:'flex', alignItems:'center', gap:6, fontSize:12, fontWeight:600, padding:'2px 4px' }}>
                {allSelected ? <CheckSquare size={15}/> : <Square size={15}/>}
                {allSelected ? 'Deselect all' : 'Select all'}
              </button>
            </div>

            {events.map(ev => {
              const [bg,fg] = (GEO_COLORS[ev.geo_scope]||'#f0f0f0|#555').split('|');
              const isPendingFix = !!ev.sent_for_correction;
              const isFixed      = !!ev.corrected_from_id;
              const isSelected   = selected.has(ev.id);
              return (
                <div key={ev.id}
                  className="card"
                  style={{ cursor:'pointer', display:'flex', alignItems:'center', gap:'0.75rem', padding:'0.9rem 1.15rem', opacity: isPendingFix ? 0.72 : 1, outline: isSelected ? '2px solid var(--green-500)' : 'none', background: isSelected ? '#f0faf0' : 'var(--surface)', transition:'box-shadow 0.18s var(--ease), transform 0.18s var(--ease)' }}
                  onMouseEnter={e=>{ e.currentTarget.style.boxShadow='var(--shadow-md)'; e.currentTarget.style.transform='translateY(-2px)'; }}
                  onMouseLeave={e=>{ e.currentTarget.style.boxShadow='var(--shadow-sm)'; e.currentTarget.style.transform='none'; }}>

                  {/* Checkbox */}
                  <button
                    onClick={e => toggleSelect(ev.id, e)}
                    style={{ background:'none', border:'none', cursor:'pointer', color: isSelected ? '#3a8c3f' : '#ccc', flexShrink:0, padding:2, display:'flex', alignItems:'center' }}>
                    {isSelected ? <CheckSquare size={17}/> : <Square size={17}/>}
                  </button>

                  {/* Clickable area */}
                  <div style={{ display:'flex', alignItems:'center', gap:'1rem', flex:1, minWidth:0 }}
                    onClick={() => router.push(`/reviewer/events/${ev.id}`)}>
                    <div style={{ width:36, height:36, borderRadius:8, background: isPendingFix ? '#fff3e0' : '#e8f5e9', display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, fontWeight:700, color: isPendingFix ? '#c05e00' : '#3a8c3f', flexShrink:0 }}>
                      {isPendingFix ? <Wrench size={16}/> : (ev.source_name?.[0] || '?')}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:2, flexWrap:'wrap' }}>
                        <span style={{ fontSize:14, fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{ev.title}</span>
                        <EventTypeBadge value={ev.event_type}/>
                        {ev.geo_scope && (
                          <span style={{ fontSize:10, padding:'1px 8px', borderRadius:20, background:bg, color:fg, fontWeight:600, flexShrink:0 }}>
                            {GEO_LABELS[ev.geo_scope]}
                          </span>
                        )}
                        {isPendingFix && (
                          <span style={{ fontSize:10, padding:'1px 8px', borderRadius:20, background:'#fff3e0', color:'#c05e00', fontWeight:700, flexShrink:0 }}>
                            Sent for correction
                          </span>
                        )}
                        {isFixed && (
                          <span style={{ fontSize:10, padding:'1px 8px', borderRadius:20, background:'#e8f5e9', color:'#2a6b2e', fontWeight:700, flexShrink:0 }}>
                            ✓ Fixed
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize:12, color:'#888', display:'flex', gap:12, flexWrap:'wrap' }}>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}><Globe size={11}/> {ev.source_name}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}><Calendar size={11}/> {formatEventDate(ev.sessions)}</span>
                        <span style={{ display:'flex', alignItems:'center', gap:3 }}><Clock size={11}/> added {new Date(ev.created_at).toLocaleDateString()}</span>
                        {isFixed && ev.sent_for_fix_by && (
                          <span style={{ color:'#3a8c3f', fontWeight:600 }}>by {ev.sent_for_fix_by}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontSize:11, color:'#bbb' }} onClick={() => router.push(`/reviewer/events/${ev.id}`)}>→</div>
                </div>
              );
            })}
          </div>
        )}

        {/* Send Back modal */}
        {sendBackModal && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem' }}
            onClick={e => { if (e.target === e.currentTarget) setSendBackModal(null); }}>
            <div style={{ background:'white', borderRadius:12, padding:'1.5rem', maxWidth:460, width:'100%', boxShadow:'0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
                <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <RotateCcw size={16} color="#c05e00"/>
                  <span style={{ fontSize:15, fontWeight:700 }}>Send back for correction</span>
                </div>
                <button onClick={() => setSendBackModal(null)} style={{ background:'none', border:'none', cursor:'pointer', color:'#bbb' }}><X size={16}/></button>
              </div>
              <p style={{ fontSize:13, color:'#666', marginBottom:'0.75rem' }}>
                <strong style={{ color:'#333' }}>{sendBackModal.title}</strong> — describe what the fix agent should change:
              </p>
              <textarea
                value={correctionNotes}
                onChange={e => setCorrectionNotes(e.target.value)}
                placeholder="e.g. The geo_scope should be city_wide not regional."
                rows={4}
                autoFocus
                style={{ width:'100%', border:'1px solid #ddd', borderRadius:7, padding:'10px 12px', fontSize:13, fontFamily:'inherit', resize:'vertical', boxSizing:'border-box', outline:'none' }}
              />
              <div style={{ display:'flex', gap:8, marginTop:'1rem', justifyContent:'flex-end' }}>
                <button onClick={() => setSendBackModal(null)} style={{ background:'#f5f5f5', border:'1px solid #ddd', color:'#666', borderRadius:7, padding:'8px 16px', fontSize:13, cursor:'pointer' }}>Cancel</button>
                <button onClick={submitSendBack} disabled={!correctionNotes.trim() || sendingBack}
                  style={{ background: correctionNotes.trim() ? '#c05e00' : '#ddd', color:'white', border:'none', borderRadius:7, padding:'8px 18px', fontSize:13, fontWeight:700, cursor: correctionNotes.trim() ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', gap:6 }}>
                  <RotateCcw size={13}/> {sendingBack ? 'Sending…' : 'Send for correction'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Bulk reject modal */}
        {bulkRejectModal && (
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'1rem' }}
            onClick={e => { if (e.target === e.currentTarget) { setBulkRejectModal(false); setBulkRejectNote(''); setBulkRejectReasons(['other']); } }}>
            <div style={{ background:'white', borderRadius:12, padding:'1.5rem', maxWidth:480, width:'100%', boxShadow:'0 8px 32px rgba(0,0,0,0.2)' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'1rem' }}>
                <span style={{ fontSize:15, fontWeight:700 }}>Reject {selected.size} event{selected.size!==1?'s':''}</span>
                <button onClick={() => setBulkRejectModal(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#bbb' }}><X size={16}/></button>
              </div>
              <p style={{ fontSize:13, color:'#666', marginBottom:'0.75rem' }}>Select reason{bulkRejectReasons.length!==1?'s':''}:</p>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:'0.75rem' }}>
                {REASON_CODES.map(r => {
                  const active = bulkRejectReasons.includes(r.code);
                  return (
                    <button key={r.code} onClick={() => setBulkRejectReasons(prev => active ? prev.filter(x=>x!==r.code) : [...prev, r.code])}
                      style={{ fontSize:11, padding:'4px 10px', borderRadius:20, border:`1px solid ${active ? '#c0392b' : '#ddd'}`, background: active ? '#fdecec' : 'white', color: active ? '#c0392b' : '#555', cursor:'pointer', fontWeight: active ? 700 : 400 }}>
                      {r.label}
                    </button>
                  );
                })}
              </div>
              <textarea
                value={bulkRejectNote}
                onChange={e => setBulkRejectNote(e.target.value)}
                placeholder="Optional note"
                rows={2}
                style={{ width:'100%', border:'1px solid #ddd', borderRadius:7, padding:'8px 12px', fontSize:13, fontFamily:'inherit', resize:'vertical', boxSizing:'border-box', outline:'none' }}
              />
              <div style={{ display:'flex', gap:8, marginTop:'1rem', justifyContent:'flex-end' }}>
                <button onClick={() => { setBulkRejectModal(false); setBulkRejectNote(''); setBulkRejectReasons(['other']); }} style={{ background:'#f5f5f5', border:'1px solid #ddd', color:'#666', borderRadius:7, padding:'8px 16px', fontSize:13, cursor:'pointer' }}>Cancel</button>
                <button onClick={bulkReject} disabled={bulkRejectReasons.length===0 || bulkProcessing}
                  style={{ background: bulkRejectReasons.length ? '#c0392b' : '#ddd', color:'white', border:'none', borderRadius:7, padding:'8px 18px', fontSize:13, fontWeight:700, cursor: bulkRejectReasons.length ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', gap:6 }}>
                  <X size={13}/> {bulkProcessing ? 'Rejecting…' : `Reject ${selected.size}`}
                </button>
              </div>
            </div>
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
