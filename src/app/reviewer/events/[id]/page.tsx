'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { ExternalLink, Check, X } from 'lucide-react';
import { formatSessionRange, getTimezoneLabel } from '@/lib/timezone';

const REASON_CODES = [
  { code: 'wrong_audience',           label: 'Wrong audience (staff/students only)' },
  { code: 'bad_date_parse',           label: 'Date or time extracted incorrectly' },
  { code: 'duplicate_missed',         label: 'Duplicate — already in CommunityHub' },
  { code: 'description_hallucinated', label: 'Description has invented details' },
  { code: 'missing_fields',           label: 'Required fields left empty' },
  { code: 'wrong_geo_scope',          label: 'Geographic scope tagged incorrectly' },
  { code: 'not_public_event',         label: 'Private or invitation-only' },
  { code: 'wrong_post_type',          label: 'Post type category incorrect' },
  { code: 'bad_location',             label: 'Location missing or wrong' },
  { code: 'other',                    label: 'Other (see note)' },
];

const LOCATION_TYPES  = ['ph2','on','bo','ne'];
const LOCATION_LABELS: Record<string,string> = { ph2:'In-person', on:'Online', bo:'Hybrid', ne:'None' };
const GEO_SCOPES      = ['hyper_local','city_wide','county','regional'];
const GEO_LABELS: Record<string,string> = { hyper_local:'Hyper-local', city_wide:'City-wide', county:'County', regional:'Regional' };

export default function ReviewEventPage() {
  const { user, token: authToken, ready } = useAuth();
  const { id }  = useParams();
  const router  = useRouter();
  const startMsRef = useRef(0);

  const [event, setEvent]           = useState<any>(null);
  const [edits, setEdits]           = useState<Record<string,any>>({});
  const [showReject, setShowReject] = useState(false);
  const [reasons, setReasons]       = useState<string[]>([]);
  const [note, setNote]             = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast]           = useState('');
  const [tzLabel]                    = useState(getTimezoneLabel);

  useEffect(() => { startMsRef.current = Date.now(); }, []);

  useEffect(() => {
    if (!ready || !authToken) return;
    fetch(`/api/review/events/${id}`, { headers: { Authorization: `Bearer ${authToken}` } })
      .then(r => r.json()).then(setEvent);
  }, [ready, authToken, id]);

  function field(key: string) {
    return edits[key] !== undefined ? edits[key] : (event?.[key] ?? '');
  }
  function set(key: string, val: any) { setEdits(e => ({ ...e, [key]: val })); }
  function parseJson(val: any) {
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return []; } }
    return val || [];
  }

  async function approve() {
    setSubmitting(true);
    const time_spent_sec = Math.round((Date.now() - startMsRef.current) / 1000);
    const res = await fetch(`/api/review/events/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action: 'approve', edits, time_spent_sec }),
    });
    if (res.ok) {
      setToast('✓ Approved and submitted to CommunityHub');
      setTimeout(() => router.push('/reviewer/queue'), 1200);
    } else {
      const d = await res.json();
      setToast(`Error: ${d.error || 'Please try again'}`);
      setSubmitting(false);
    }
  }

  async function reject() {
    if (!reasons.length) return;
    setSubmitting(true);
    const time_spent_sec = Math.round((Date.now() - startMsRef.current) / 1000);
    await fetch(`/api/review/events/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action: 'reject', edits: { reason_codes: reasons, reviewer_note: note }, time_spent_sec }),
    });
    setToast('Event rejected');
    setTimeout(() => router.push('/reviewer/queue'), 1000);
  }

  if (!ready || !user) return null;

  if (!event) return (
    <div style={{ display:'flex', minHeight:'100vh' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={authToken}/>
      <main style={{ flex:1, padding:'2rem', color:'#888', fontSize:14 }}>Loading…</main>
    </div>
  );

  const sessions = parseJson(event.sessions);

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:'#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={authToken}/>

      <main style={{ flex:1, padding:'2rem', maxWidth:780 }}>
        {toast && (
          <div style={{ position:'fixed', top:20, right:20, background: toast.startsWith('Error') ? '#c0392b' : '#3a8c3f', color:'white', padding:'0.75rem 1.25rem', borderRadius:8, fontSize:13, fontWeight:500, zIndex:999 }}>
            {toast}
          </div>
        )}

        <div style={{ marginBottom:'1rem', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
          <div>
            <button onClick={() => router.push('/reviewer/queue')} style={{ background:'none', border:'none', cursor:'pointer', color:'#888', fontSize:12, padding:0, marginBottom:6 }}>← Back to queue</button>
            <h1 style={{ fontSize:20, fontWeight:700 }}>Review event</h1>
          </div>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={() => setShowReject(true)} disabled={submitting} className="btn-ghost"
              style={{ fontSize:13, display:'flex', alignItems:'center', gap:5, borderColor:'#c0392b', color:'#c0392b' }}>
              <X size={14}/> Reject
            </button>
            <button onClick={approve} disabled={submitting} className="btn-primary"
              style={{ fontSize:13, display:'flex', alignItems:'center', gap:5 }}>
              <Check size={14}/> Approve & submit
            </button>
          </div>
        </div>

        {/* Source info */}
        <div style={{ background:'#e8f5e9', borderRadius:8, padding:'0.75rem 1rem', marginBottom:'1.25rem', fontSize:12, display:'flex', gap:16, alignItems:'center' }}>
          <span style={{ fontWeight:600, color:'#2a6b2e' }}>{event.source_name}</span>
          {event.calendar_source_url && (
            <a href={event.calendar_source_url} target="_blank" rel="noreferrer"
              style={{ display:'flex', alignItems:'center', gap:4, color:'#3a8c3f', textDecoration:'none', fontSize:11 }}>
              <ExternalLink size={11}/> View source
            </a>
          )}
          <span style={{ color:'#666' }}>Received: {new Date(event.created_at).toLocaleDateString()}</span>
          {tzLabel && <span style={{ color:'#aaa', marginLeft:'auto', fontSize:11 }}>Times shown in {tzLabel}</span>}
        </div>

        <div className="card" style={{ display:'flex', flexDirection:'column', gap:'1rem' }}>
          <Field label={`Title (${(field('title')?.length||0)}/60 chars)`}>
            <input value={field('title')} onChange={e=>set('title',e.target.value)} maxLength={60} style={inputStyle}/>
          </Field>

          <Field label={`Short description (${(field('description')?.length||0)}/200 chars)`}>
            <textarea value={field('description')} onChange={e=>set('description',e.target.value)} maxLength={200} rows={2} style={{...inputStyle,resize:'vertical'}}/>
          </Field>

          <Field label="Long description (max 1000 chars)">
            <textarea value={field('extended_description')||''} onChange={e=>set('extended_description',e.target.value)} maxLength={1000} rows={4} style={{...inputStyle,resize:'vertical'}}/>
          </Field>

          {/* Date/time — shown in reviewer's local timezone */}
          {sessions.length > 0 && (
            <Field label="Date & time (your local timezone)">
              <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                {sessions.map((s: any, i: number) => (
                  <div key={i} style={{ fontSize:13, color:'#333', padding:'0.4rem 0.6rem', background:'#f8f9fa', borderRadius:6 }}>
                    {formatSessionRange(s.startTime, s.endTime)}
                  </div>
                ))}
                {sessions.length > 1 && (
                  <div style={{ fontSize:11, color:'#aaa' }}>{sessions.length} sessions total</div>
                )}
              </div>
            </Field>
          )}

          <Field label="Location type">
            <div style={{ display:'flex', gap:6 }}>
              {LOCATION_TYPES.map(lt => (
                <button key={lt} onClick={()=>set('location_type',lt)}
                  style={{ padding:'0.35rem 0.75rem', borderRadius:6, border:'1.5px solid', fontSize:12, cursor:'pointer',
                    borderColor: field('location_type')===lt ? '#3a8c3f' : '#ddd',
                    background:  field('location_type')===lt ? '#e8f5e9' : 'white',
                    color:       field('location_type')===lt ? '#2a6b2e' : '#555',
                    fontWeight:  field('location_type')===lt ? 600 : 400 }}>
                  {LOCATION_LABELS[lt]}
                </button>
              ))}
            </div>
          </Field>

          {['ph2','bo'].includes(field('location_type')) && (
            <Field label="Address">
              <input value={field('location')||''} onChange={e=>set('location',e.target.value)} style={inputStyle} placeholder="Street, City, State ZIP"/>
            </Field>
          )}
          {['on','bo'].includes(field('location_type')) && (
            <Field label="Stream / event URL">
              <input value={field('url_link')||''} onChange={e=>set('url_link',e.target.value)} style={inputStyle} placeholder="https://…"/>
            </Field>
          )}

          <Field label="Geographic scope">
            <div style={{ display:'flex', gap:6 }}>
              {GEO_SCOPES.map(gs => (
                <button key={gs} onClick={()=>set('geo_scope',gs)}
                  style={{ padding:'0.35rem 0.75rem', borderRadius:6, border:'1.5px solid', fontSize:12, cursor:'pointer',
                    borderColor: field('geo_scope')===gs ? '#3a8c3f' : '#ddd',
                    background:  field('geo_scope')===gs ? '#e8f5e9' : 'white',
                    color:       field('geo_scope')===gs ? '#2a6b2e' : '#555',
                    fontWeight:  field('geo_scope')===gs ? 600 : 400 }}>
                  {GEO_LABELS[gs]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Sponsors">
            <input value={parseJson(field('sponsors')).join(', ')}
              onChange={e=>set('sponsors',e.target.value.split(',').map((s:string)=>s.trim()).filter(Boolean))}
              style={inputStyle} placeholder="Sponsor 1, Sponsor 2"/>
          </Field>

          <Field label="Image URL">
            <input value={field('image_cdn_url')||''} onChange={e=>set('image_cdn_url',e.target.value)} style={inputStyle} placeholder="https://…"/>
            {field('image_cdn_url') && (
              <img src={field('image_cdn_url')} alt="preview" style={{ marginTop:8, maxHeight:120, borderRadius:6, objectFit:'cover' }}/>
            )}
          </Field>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <Field label="Contact email">
              <input value={field('contact_email')||''} onChange={e=>set('contact_email',e.target.value)} style={inputStyle}/>
            </Field>
            <Field label="Phone">
              <input value={field('phone')||''} onChange={e=>set('phone',e.target.value)} style={inputStyle}/>
            </Field>
          </div>

          {event.ingested_post_url && (
            <Field label="Deep link (ingestedPostUrl)">
              <a href={event.ingested_post_url} target="_blank" rel="noreferrer"
                style={{ fontSize:12, color:'#3a8c3f', textDecoration:'none', display:'flex', alignItems:'center', gap:4 }}>
                <ExternalLink size={12}/> {event.ingested_post_url}
              </a>
            </Field>
          )}
        </div>
      </main>

      {showReject && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}>
          <div style={{ background:'white', borderRadius:12, padding:'1.75rem', width:'100%', maxWidth:440 }}>
            <h2 style={{ fontSize:17, fontWeight:700, marginBottom:'0.25rem' }}>Reject event</h2>
            <p style={{ fontSize:13, color:'#888', marginBottom:'1rem' }}>Select all reasons that apply — the agent will learn from this</p>
            <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:'1rem' }}>
              {REASON_CODES.map(({ code, label }) => (
                <label key={code} style={{ display:'flex', alignItems:'center', gap:8, fontSize:13, cursor:'pointer', padding:'0.4rem 0.5rem', borderRadius:6, background:reasons.includes(code)?'#fdecea':'transparent' }}>
                  <input type="checkbox" checked={reasons.includes(code)}
                    onChange={e => setReasons(r => e.target.checked ? [...r,code] : r.filter(x=>x!==code))}/>
                  {label}
                </label>
              ))}
            </div>
            <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Optional note for the agent…" rows={2}
              style={{...inputStyle,resize:'vertical',marginBottom:'1rem'}}/>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={()=>setShowReject(false)} className="btn-ghost" style={{ fontSize:13 }}>Cancel</button>
              <button onClick={reject} disabled={!reasons.length||submitting} className="btn-danger" style={{ fontSize:13 }}>
                Confirm reject
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label:string; children:React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize:11, fontWeight:600, color:'#888', textTransform:'uppercase', letterSpacing:0.5, display:'block', marginBottom:4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width:'100%', padding:'0.55rem 0.75rem',
  border:'1.5px solid #ddd', borderRadius:6,
  fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:'inherit',
};
