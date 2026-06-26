'use client';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useParams, useRouter } from 'next/navigation';
import Sidebar from '@/components/layout/Sidebar';
import { ExternalLink, Check, X, Plus, Trash2, Save, RotateCcw } from 'lucide-react';
import { getTimezoneLabel } from '@/lib/timezone';

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
const EVENT_TYPES     = [['ot','Event'],['an','Announcement'],['jp','Job posting']] as const;
const DISPLAY_OPTIONS = [['all','All screens'],['ps','Primary'],['sps','Secondary'],['ss','Single']] as const;
const POST_TYPES = [
  { id:1,  label:'Volunteer Opportunity' },
  { id:2,  label:'Exhibit' },
  { id:3,  label:'Fair / Festival / Celebration' },
  { id:4,  label:'Tour / Open House' },
  { id:5,  label:'Film' },
  { id:6,  label:'Presentation / Lecture' },
  { id:7,  label:'Workshop / Class' },
  { id:8,  label:'Music Performance' },
  { id:9,  label:'Theatre / Dance' },
  { id:10, label:'City Government' },
  { id:11, label:'Spectator Sport' },
  { id:12, label:'Participatory Sport / Game' },
  { id:13, label:'Networking Event' },
  { id:59, label:'Ecolympics / Environmental' },
  { id:89, label:'Other' },
];

function toDatetimeLocal(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(val: string): number {
  if (!val) return 0;
  return Math.floor(new Date(val).getTime() / 1000);
}

export default function ReviewEventPage() {
  const { user, token: authToken, ready } = useAuth();
  const { id }  = useParams();
  const router  = useRouter();
  const startMsRef = useRef(0);

  const [event, setEvent]           = useState<any>(null);
  const [edits, setEdits]           = useState<Record<string,any>>({});
  const [showReject, setShowReject] = useState(false);
  const [showSendBack, setShowSendBack] = useState(false);
  const [correctionNotes, setCorrectionNotes] = useState('');
  const [sendingBack, setSendingBack]         = useState(false);
  const [reasons, setReasons]       = useState<string[]>([]);
  const [note, setNote]             = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving]         = useState(false);
  const [toast, setToast]           = useState('');
  const [tzLabel]                   = useState(getTimezoneLabel);

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
  function parseJson(val: any, fallback: any = []) {
    if (val === null || val === undefined) return fallback;
    if (typeof val === 'string') { try { return JSON.parse(val); } catch { return fallback; } }
    return val;
  }

  // Sessions
  const editSessions: Array<{startTime: number, endTime: number}> = parseJson(field('sessions'));
  function updateSession(i: number, key: 'startTime'|'endTime', val: string) {
    set('sessions', editSessions.map((s, idx) => idx === i ? { ...s, [key]: fromDatetimeLocal(val) } : s));
  }
  function addSession() { set('sessions', [...editSessions, { startTime: 0, endTime: 0 }]); }
  function removeSession(i: number) { set('sessions', editSessions.filter((_, idx) => idx !== i)); }

  // Buttons
  const editButtons: Array<{title: string, link: string}> = parseJson(field('buttons'), []);
  function updateButton(i: number, key: 'title'|'link', val: string) {
    set('buttons', editButtons.map((b, idx) => idx === i ? { ...b, [key]: val } : b));
  }
  function addButton() { set('buttons', [...editButtons, { title: '', link: '' }]); }
  function removeButton(i: number) { set('buttons', editButtons.filter((_, idx) => idx !== i)); }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  }

  async function saveEdits() {
    if (!Object.keys(edits).length) return;
    setSaving(true);
    const res = await fetch(`/api/events/${id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ edits }),
    });
    if (res.ok) {
      const data = await res.json();
      setEvent(data.event);
      setEdits({});
      showToast(`✓ Saved${data.changed_fields.length ? ': ' + data.changed_fields.join(', ') : ''}`);
    } else {
      const d = await res.json().catch(() => ({}));
      showToast(`Error: ${d.error || 'Save failed'}`);
    }
    setSaving(false);
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
      showToast('✓ Approved and submitted to CommunityHub');
      setTimeout(() => router.push('/reviewer/queue'), 1200);
    } else {
      const d = await res.json().catch(() => ({}));
      showToast(`Error: ${d.error || 'Please try again'}`);
      setSubmitting(false);
    }
  }

  async function sendBackForCorrection() {
    if (!correctionNotes.trim()) return;
    setSendingBack(true);
    const res = await fetch(`/api/review/events/${id}/send-for-correction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ correction_notes: correctionNotes }),
    });
    if (res.ok) {
      showToast('Sent for correction — fix agent will pick it up');
      setShowSendBack(false);
      setCorrectionNotes('');
      setTimeout(() => router.push('/reviewer/queue'), 1200);
    } else {
      const d = await res.json().catch(() => ({}));
      showToast(`Error: ${d.error || 'Please try again'}`);
      setSendingBack(false);
    }
  }

  async function reject() {
    if (!reasons.length) return;
    setSubmitting(true);
    const time_spent_sec = Math.round((Date.now() - startMsRef.current) / 1000);
    const res = await fetch(`/api/review/events/${id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action: 'reject', edits: { reason_codes: reasons, reviewer_note: note }, time_spent_sec }),
    });
    if (res.ok) {
      showToast('Event rejected');
      setTimeout(() => router.push('/reviewer/queue'), 1000);
    } else {
      const d = await res.json().catch(() => ({}));
      showToast(`Error: ${d.error || 'Please try again'}`);
      setSubmitting(false);
    }
  }

  if (!ready || !user) return null;

  if (!event) return (
    <div style={{ display:'flex', minHeight:'100vh' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={authToken}/>
      <main style={{ flex:1, padding:'2rem', color:'#888', fontSize:14 }}>Loading…</main>
    </div>
  );

  const hasEdits    = Object.keys(edits).length > 0;
  const postTypeIds: number[] = parseJson(field('post_type_ids'), []);

  return (
    <div style={{ display:'flex', minHeight:'100vh', background:'#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={authToken}/>

      <main style={{ flex:1, padding:'2rem', maxWidth:840 }}>
        {toast && (
          <div style={{ position:'fixed', top:20, right:20, background: toast.startsWith('Error') ? '#c0392b' : '#3a8c3f', color:'white', padding:'0.75rem 1.25rem', borderRadius:8, fontSize:13, fontWeight:500, zIndex:999 }}>
            {toast}
          </div>
        )}

        <div style={{ marginBottom:'1rem', display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
          <div>
            <button onClick={() => router.push('/reviewer/queue')} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--gray-mid)', fontSize:12, fontWeight:500, padding:0, marginBottom:7 }}>← Back to queue</button>
            <h1 style={{ fontSize:24, fontWeight:800 }}>Review event</h1>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', justifyContent:'flex-end' }}>
            <button onClick={saveEdits} disabled={!hasEdits || saving} className="btn-ghost"
              style={{ fontSize:13, display:'flex', alignItems:'center', gap:5, opacity: hasEdits ? 1 : 0.4 }}>
              <Save size={14}/> {saving ? 'Saving…' : 'Save edits'}
            </button>
            {event?.source_slug !== 'fixed-events' && (
              <button onClick={() => { setShowSendBack(true); setCorrectionNotes(''); }} disabled={submitting} className="btn-ghost"
                style={{ fontSize:13, display:'flex', alignItems:'center', gap:5, borderColor:'#c05e00', color:'#c05e00' }}>
                <RotateCcw size={14}/> Send for fix
              </button>
            )}
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

        {/* Source info bar */}
        <div style={{ background:'linear-gradient(180deg, #ecf7ed, #e3f3e5)', border:'1px solid var(--green-200)', borderRadius:'var(--r-md)', padding:'0.7rem 1rem', marginBottom:'1.25rem', fontSize:12, display:'flex', gap:16, alignItems:'center', flexWrap:'wrap' }}>
          <span style={{ fontWeight:700, color:'var(--green-700)' }}>{event.source_name}</span>
          {event.calendar_source_url && (
            <a href={event.calendar_source_url} target="_blank" rel="noreferrer"
              style={{ display:'flex', alignItems:'center', gap:4, color:'#3a8c3f', textDecoration:'none', fontSize:11 }}>
              <ExternalLink size={11}/> View source
            </a>
          )}
          <span style={{ color:'#666' }}>Received: {new Date(event.created_at).toLocaleDateString()}</span>
          {tzLabel && <span style={{ color:'#aaa', marginLeft:'auto', fontSize:11 }}>Times in {tzLabel}</span>}
        </div>

        {/* Basic Info */}
        <SectionCard title="Basic Info">
          <Field label="Event type">
            <div style={{ display:'flex', gap:6 }}>
              {EVENT_TYPES.map(([val, lbl]) => (
                <ToggleBtn key={val} active={field('event_type')===val} onClick={()=>set('event_type',val)}>{lbl}</ToggleBtn>
              ))}
            </div>
          </Field>

          <Field label={`Title (${(field('title')?.length||0)}/60 chars)`}>
            <input value={field('title')} onChange={e=>set('title',e.target.value)} maxLength={60} style={inputStyle}/>
          </Field>

          <Field label={`Short description (${(field('description')?.length||0)}/200 chars)`}>
            <textarea value={field('description')} onChange={e=>set('description',e.target.value)} maxLength={200} rows={2} style={{...inputStyle,resize:'vertical'}}/>
          </Field>

          <Field label="Long description (max 1000 chars)">
            <textarea value={field('extended_description')||''} onChange={e=>set('extended_description',e.target.value)} maxLength={1000} rows={4} style={{...inputStyle,resize:'vertical'}}/>
          </Field>
        </SectionCard>

        {/* Date & Time */}
        <SectionCard title="Date & Time">
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            {editSessions.map((s, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 1fr auto', gap:8, alignItems:'flex-end' }}>
                <Field label={`Session ${i+1} — Start`}>
                  <input type="datetime-local" value={toDatetimeLocal(s.startTime)}
                    onChange={e=>updateSession(i,'startTime',e.target.value)} style={inputStyle}/>
                </Field>
                <Field label="End">
                  <input type="datetime-local" value={toDatetimeLocal(s.endTime)}
                    onChange={e=>updateSession(i,'endTime',e.target.value)} style={inputStyle}/>
                </Field>
                <button onClick={()=>removeSession(i)}
                  style={{ background:'none', border:'1.5px solid #fca5a5', borderRadius:6, cursor:'pointer', padding:'0.4rem 0.6rem', color:'#c0392b', marginBottom:1 }}>
                  <Trash2 size={13}/>
                </button>
              </div>
            ))}
            {editSessions.length === 0 && (
              <div style={{ fontSize:12, color:'#aaa' }}>No sessions — add one below.</div>
            )}
            <button onClick={addSession}
              style={{ display:'flex', alignItems:'center', gap:5, background:'none', border:'1.5px dashed #bbb', borderRadius:6, padding:'0.4rem 0.75rem', cursor:'pointer', fontSize:12, color:'#666', width:'fit-content' }}>
              <Plus size={12}/> Add session
            </button>
          </div>
        </SectionCard>

        {/* Location */}
        <SectionCard title="Location">
          <Field label="Location type">
            <div style={{ display:'flex', gap:6 }}>
              {LOCATION_TYPES.map(lt => (
                <ToggleBtn key={lt} active={field('location_type')===lt} onClick={()=>set('location_type',lt)}>
                  {LOCATION_LABELS[lt]}
                </ToggleBtn>
              ))}
            </div>
          </Field>

          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <Field label="Place name">
              <input value={field('place_name')||''} onChange={e=>set('place_name',e.target.value)} style={inputStyle} placeholder="Venue name"/>
            </Field>
            <Field label="Room / suite">
              <input value={field('room_num')||''} onChange={e=>set('room_num',e.target.value)} style={inputStyle} placeholder="Room 101"/>
            </Field>
          </div>

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
        </SectionCard>

        {/* Categorization */}
        <SectionCard title="Categorization">
          <Field label="Post type categories">
            <div style={{ display:'flex', flexWrap:'wrap', gap:5 }}>
              {POST_TYPES.map(({ id: ptId, label }) => {
                const selected = postTypeIds.includes(ptId);
                return (
                  <label key={ptId} style={{ display:'flex', alignItems:'center', gap:4, fontSize:12, padding:'0.3rem 0.65rem', borderRadius:6, border:'1.5px solid', cursor:'pointer',
                    borderColor: selected ? '#3a8c3f' : '#ddd',
                    background:  selected ? '#e8f5e9' : 'white',
                    color:       selected ? '#2a6b2e' : '#555',
                    fontWeight:  selected ? 600 : 400 }}>
                    <input type="checkbox" style={{ display:'none' }} checked={selected}
                      onChange={e => {
                        const next = e.target.checked
                          ? [...postTypeIds, ptId]
                          : postTypeIds.filter((x: number) => x !== ptId);
                        set('post_type_ids', next);
                      }}/>
                    {label}
                  </label>
                );
              })}
            </div>
          </Field>

          <Field label="Geographic scope">
            <div style={{ display:'flex', gap:6 }}>
              {GEO_SCOPES.map(gs => (
                <ToggleBtn key={gs} active={field('geo_scope')===gs} onClick={()=>set('geo_scope',gs)}>
                  {GEO_LABELS[gs]}
                </ToggleBtn>
              ))}
            </div>
          </Field>

          <Field label="Display">
            <div style={{ display:'flex', gap:6 }}>
              {DISPLAY_OPTIONS.map(([val, lbl]) => (
                <ToggleBtn key={val} active={field('display')===val} onClick={()=>set('display',val)}>{lbl}</ToggleBtn>
              ))}
            </div>
          </Field>

          <Field label="Sponsors">
            <input value={parseJson(field('sponsors'), []).join(', ')}
              onChange={e=>set('sponsors', e.target.value.split(',').map((s:string)=>s.trim()).filter(Boolean))}
              style={inputStyle} placeholder="Sponsor 1, Sponsor 2"/>
          </Field>
        </SectionCard>

        {/* Contact & Media */}
        <SectionCard title="Contact & Media">
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <Field label="Email">
              <input value={field('email')||''} onChange={e=>set('email',e.target.value)} style={inputStyle}/>
            </Field>
            <Field label="Contact email">
              <input value={field('contact_email')||''} onChange={e=>set('contact_email',e.target.value)} style={inputStyle}/>
            </Field>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <Field label="Phone">
              <input value={field('phone')||''} onChange={e=>set('phone',e.target.value)} style={inputStyle}/>
            </Field>
          </div>

          <Field label="Website">
            <input value={field('website')||''} onChange={e=>set('website',e.target.value)} style={inputStyle} placeholder="https://…"/>
          </Field>

          <Field label="Image URL">
            <input value={field('image_cdn_url')||''} onChange={e=>set('image_cdn_url',e.target.value)} style={inputStyle} placeholder="https://…"/>
            {field('image_cdn_url') && (
              <img src={field('image_cdn_url')} alt="preview" style={{ marginTop:8, maxHeight:120, borderRadius:6, objectFit:'cover' }}/>
            )}
          </Field>
        </SectionCard>

        {/* Buttons / Links */}
        <SectionCard title="Buttons / Links">
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {editButtons.map((btn, i) => (
              <div key={i} style={{ display:'grid', gridTemplateColumns:'1fr 2fr auto', gap:8, alignItems:'flex-end' }}>
                <Field label={i === 0 ? 'Label' : ''}>
                  <input value={btn.title} onChange={e=>updateButton(i,'title',e.target.value)} style={inputStyle} placeholder="Get Tickets"/>
                </Field>
                <Field label={i === 0 ? 'URL' : ''}>
                  <input value={btn.link} onChange={e=>updateButton(i,'link',e.target.value)} style={inputStyle} placeholder="https://…"/>
                </Field>
                <button onClick={()=>removeButton(i)}
                  style={{ background:'none', border:'1.5px solid #fca5a5', borderRadius:6, cursor:'pointer', padding:'0.4rem 0.6rem', color:'#c0392b', marginBottom:1 }}>
                  <Trash2 size={13}/>
                </button>
              </div>
            ))}
            {editButtons.length === 0 && (
              <div style={{ fontSize:12, color:'#aaa' }}>No buttons.</div>
            )}
            <button onClick={addButton}
              style={{ display:'flex', alignItems:'center', gap:5, background:'none', border:'1.5px dashed #bbb', borderRadius:6, padding:'0.4rem 0.75rem', cursor:'pointer', fontSize:12, color:'#666', width:'fit-content' }}>
              <Plus size={12}/> Add button
            </button>
          </div>
        </SectionCard>

        {/* Source */}
        <SectionCard title="Source">
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1rem' }}>
            <Field label="Source name">
              <input value={field('calendar_source_name')||''} onChange={e=>set('calendar_source_name',e.target.value)} style={inputStyle}/>
            </Field>
            <Field label="Source URL">
              <input value={field('calendar_source_url')||''} onChange={e=>set('calendar_source_url',e.target.value)} style={inputStyle} placeholder="https://…"/>
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
        </SectionCard>
      </main>

      {showSendBack && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}
          onClick={e => { if (e.target === e.currentTarget) setShowSendBack(false); }}>
          <div style={{ background:'white', borderRadius:12, padding:'1.75rem', width:'100%', maxWidth:440 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'0.5rem' }}>
              <h2 style={{ fontSize:17, fontWeight:700 }}>Send back for correction</h2>
              <button onClick={() => setShowSendBack(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#bbb' }}><X size={16}/></button>
            </div>
            <p style={{ fontSize:13, color:'#888', marginBottom:'1rem' }}>Describe what the fix agent should change:</p>
            <textarea
              value={correctionNotes}
              onChange={e => setCorrectionNotes(e.target.value)}
              placeholder="e.g. geo_scope should be city_wide. The poster image is wrong — use a different one."
              rows={4}
              autoFocus
              style={{...inputStyle, resize:'vertical', marginBottom:'1rem'}}
            />
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowSendBack(false)} className="btn-ghost" style={{ fontSize:13 }}>Cancel</button>
              <button
                onClick={sendBackForCorrection}
                disabled={!correctionNotes.trim() || sendingBack}
                style={{ background: correctionNotes.trim() ? '#c05e00' : '#ddd', color:'white', border:'none', borderRadius:7, padding:'8px 18px', fontSize:13, fontWeight:700, cursor: correctionNotes.trim() ? 'pointer' : 'not-allowed', display:'flex', alignItems:'center', gap:6 }}>
                <RotateCcw size={13}/> {sendingBack ? 'Sending…' : 'Send for correction'}
              </button>
            </div>
          </div>
        </div>
      )}

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

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card" style={{ display:'flex', flexDirection:'column', gap:'1rem', marginBottom:'1rem' }}>
      <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, fontWeight:700, color:'var(--green-700)', textTransform:'uppercase', letterSpacing:0.9, borderBottom:'1px solid var(--border-soft)', paddingBottom:'0.6rem' }}>
        <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--green-500)' }}/>
        {title}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label && <label style={{ fontSize:11, fontWeight:600, color:'#888', textTransform:'uppercase', letterSpacing:0.5, display:'block', marginBottom:4 }}>{label}</label>}
      {children}
    </div>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: ()=>void; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      style={{ padding:'0.4rem 0.8rem', borderRadius:'var(--r-sm)', border:'1px solid', fontSize:12, cursor:'pointer',
        transition:'all 0.14s var(--ease)',
        borderColor: active ? 'var(--green-400)' : 'var(--gray-300)',
        background:  active ? 'var(--green-100)' : 'var(--surface)',
        color:       active ? 'var(--green-700)' : 'var(--gray-700)',
        boxShadow:   active ? 'var(--shadow-xs)' : 'none',
        fontWeight:  active ? 700 : 500 }}>
      {children}
    </button>
  );
}

const inputStyle: React.CSSProperties = {
  width:'100%', padding:'0.6rem 0.8rem',
  border:'1px solid var(--gray-300)', borderRadius:'var(--r-sm)',
  fontSize:13, outline:'none', boxSizing:'border-box', fontFamily:'inherit',
  color:'var(--black)', background:'var(--surface)',
  transition:'border-color 0.15s var(--ease), box-shadow 0.15s var(--ease)',
};
