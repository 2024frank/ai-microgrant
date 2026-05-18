'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { ExternalLink, Pencil, Check, X, BookOpen, Send } from 'lucide-react';
import { formatSessionRange, getTimezoneLabel } from '@/lib/timezone';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import firebaseApp from '@/lib/firebase';

const STATUS_STYLES: Record<string, { bg:string; color:string; label:string }> = {
  pending:     { bg:'#fff3e0', color:'#c05e00', label:'Pending review' },
  approved:    { bg:'#e8f5e9', color:'#2a6b2e', label:'Published'      },
  rejected:    { bg:'#fdecea', color:'#c0392b', label:'Rejected'       },
  resubmitted: { bg:'#e3f2fd', color:'#1565c0', label:'Resubmitted'    },
};
const GEO_LABELS: Record<string,string> = {
  hyper_local:'Hyper-local', city_wide:'City-wide', county:'County', regional:'Regional',
};

export default function EventDeepLinkPage() {
  const { id } = useParams();
  const [event, setEvent]     = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [tzLabel]             = useState(getTimezoneLabel);

  // Auth
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [userRole,  setUserRole]  = useState<string | null>(null);

  // Edit state
  const [editing,       setEditing]       = useState(false);
  const [edits,         setEdits]         = useState<Record<string,string>>({});
  const [note,          setNote]          = useState('');
  const [saving,        setSaving]        = useState(false);
  const [lastSaveResult, setLastSaveResult] = useState<{fields: string[]; corrections: {field:string;from:string;to:string}[]} | null>(null);

  // Resubmit state
  const [resubmitting,  setResubmitting]  = useState(false);
  const [resubmitMsg,   setResubmitMsg]   = useState('');

  useEffect(() => {
    const auth = getAuth(firebaseApp);
    return onAuthStateChanged(auth, async (u) => {
      if (u) {
        const token = await u.getIdToken();
        setAuthToken(token);
        try {
          const res = await fetch('/api/users/me', { headers: { Authorization: `Bearer ${token}` } });
          if (res.ok) { const me = await res.json(); setUserRole(me.role); }
        } catch { /* no role */ }
      } else { setAuthToken(null); setUserRole(null); }
    });
  }, []);

  useEffect(() => {
    fetch(`/api/events/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setEvent)
      .catch(() => setError('Event not found'))
      .finally(() => setLoading(false));
  }, [id]);

  const canEdit = authToken && (userRole === 'admin' || userRole === 'reviewer');

  function startEdit() {
    setEdits({
      title:                event.title                || '',
      description:          event.description          || '',
      extended_description: event.extended_description || '',
      location:             event.location             || '',
      place_name:           event.place_name           || '',
      room_num:             event.room_num             || '',
      contact_email:        event.contact_email        || '',
      phone:                event.phone                || '',
      website:              event.website              || '',
    });
    setNote('');
    setLastSaveResult(null);
    setResubmitMsg('');
    setEditing(true);
  }

  async function saveEdits() {
    if (!authToken) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/events/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ edits, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');

      // Build per-field correction summary for the UI
      const corrections = (data.changed_fields || []).map((f: string) => ({
        field: f,
        from: String((event as any)[f] ?? '').slice(0, 120),
        to:   String((edits as any)[f] ?? '').slice(0, 120),
      }));

      setEvent(data.event);
      setEditing(false);
      setNote('');
      setLastSaveResult({ fields: data.changed_fields || [], corrections });
      setResubmitMsg('');
    } catch (err: any) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function resubmit() {
    if (!authToken) return;
    setResubmitting(true);
    setResubmitMsg('');
    try {
      const res = await fetch(`/api/review/events/${id}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ action: 'approve', edits: {}, time_spent_sec: 0 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Resubmit failed');
      const postId = data.communityhub?.id || data.communityhub?.postId || '?';
      setResubmitMsg(`✅ Sent to CommunityHub — post #${postId}`);
      setLastSaveResult(null);
      const r2 = await fetch(`/api/events/${id}`);
      if (r2.ok) setEvent(await r2.json());
    } catch (err: any) {
      setResubmitMsg(`❌ ${err.message}`);
    } finally {
      setResubmitting(false);
    }
  }

  if (loading) return (
    <div style={{ minHeight:'100vh', background:'#f0f7f0', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ color:'#888', fontSize:14 }}>Loading…</div>
    </div>
  );
  if (error) return (
    <div style={{ minHeight:'100vh', background:'#f0f7f0', display:'flex', alignItems:'center', justifyContent:'center' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontSize:36, marginBottom:12 }}>🔍</div>
        <div style={{ fontSize:18, fontWeight:700 }}>Event not found</div>
      </div>
    </div>
  );

  const sessions = Array.isArray(event.sessions) ? event.sessions : [];
  const sponsors = Array.isArray(event.sponsors)  ? event.sponsors  : [];
  const buttons  = Array.isArray(event.buttons)   ? event.buttons   : [];
  const status   = STATUS_STYLES[event.status]    || STATUS_STYLES.pending;

  return (
    <div style={{ minHeight:'100vh', background:'#f0f7f0', padding:'2rem 1rem' }}>
      <div style={{ maxWidth:640, margin:'0 auto' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:'1.5rem' }}>
          <Image src="/logo.png" alt="AI Events Aggregator" width={32} height={32}/>
          <div style={{ fontSize:12, fontWeight:800, color:'#3a8c3f', letterSpacing:0.5 }}>AI EVENTS AGGREGATOR</div>
        </div>

        <div style={{ background:'white', borderRadius:12, overflow:'hidden', boxShadow:'0 2px 16px rgba(0,0,0,0.08)' }}>
          {event.image_cdn_url && (
            <img src={event.image_cdn_url} alt={event.title}
              style={{ width:'100%', height:200, objectFit:'cover', display:'block' }}/>
          )}

          <div style={{ padding:'1.5rem' }}>

            {/* Status row */}
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:'0.75rem', flexWrap:'wrap' }}>
              <span style={{ background:status.bg, color:status.color, fontSize:11, fontWeight:700, padding:'2px 10px', borderRadius:20 }}>
                {status.label}
              </span>
              {event.geo_scope && (
                <span style={{ background:'#e8f5e9', color:'#2a6b2e', fontSize:11, fontWeight:600, padding:'2px 10px', borderRadius:20 }}>
                  {GEO_LABELS[event.geo_scope] || event.geo_scope}
                </span>
              )}
              <span style={{ fontSize:11, color:'#aaa', marginLeft:'auto' }}>Source: {event.calendar_source_name}</span>
              {canEdit && !editing && (
                <button onClick={startEdit}
                  style={{ display:'flex', alignItems:'center', gap:4, background:'#f0f7f0', border:'1px solid #c8e6c9', color:'#3a8c3f', borderRadius:6, padding:'4px 10px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                  <Pencil size={12}/> Edit
                </button>
              )}
            </div>

            {/* ── EDIT MODE ── */}
            {editing ? (
              <div>
                <EditField label="Title"                value={edits.title}                onChange={v => setEdits(e=>({...e,title:v}))}/>
                <EditField label="Description"          value={edits.description}          onChange={v => setEdits(e=>({...e,description:v}))}          multiline/>
                <EditField label="Extended description" value={edits.extended_description} onChange={v => setEdits(e=>({...e,extended_description:v}))} multiline/>
                <EditField label="Location"             value={edits.location}             onChange={v => setEdits(e=>({...e,location:v}))}/>
                <EditField label="Venue name"           value={edits.place_name}           onChange={v => setEdits(e=>({...e,place_name:v}))}/>
                <EditField label="Room / floor"         value={edits.room_num}             onChange={v => setEdits(e=>({...e,room_num:v}))}/>
                <EditField label="Contact email"        value={edits.contact_email}        onChange={v => setEdits(e=>({...e,contact_email:v}))}/>
                <EditField label="Phone"                value={edits.phone}                onChange={v => setEdits(e=>({...e,phone:v}))}/>
                <EditField label="Website"              value={edits.website}              onChange={v => setEdits(e=>({...e,website:v}))}/>

                {/* Reason field — feeds directly into agent learning */}
                <div style={{ marginTop:4, marginBottom:16 }}>
                  <label style={{ fontSize:11, fontWeight:700, color:'#3a8c3f', textTransform:'uppercase', letterSpacing:0.5, display:'flex', alignItems:'center', gap:4 }}>
                    <BookOpen size={11}/> Why are you making this correction? (AI will learn from this)
                  </label>
                  <textarea
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="e.g. Wrong location — this is an online event not in-person"
                    rows={2}
                    style={{ width:'100%', border:'1px solid #c8e6c9', borderRadius:6, padding:'7px 10px', fontSize:13, fontFamily:'inherit', color:'#333', background:'#f0f7f0', boxSizing:'border-box', marginTop:4, resize:'vertical' }}
                  />
                </div>

                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={saveEdits} disabled={saving}
                    style={{ display:'flex', alignItems:'center', gap:4, background:'#3a8c3f', color:'white', border:'none', borderRadius:7, padding:'8px 18px', fontSize:13, fontWeight:700, cursor:saving?'wait':'pointer', opacity:saving?0.7:1 }}>
                    <Check size={14}/> {saving ? 'Saving…' : 'Save changes'}
                  </button>
                  <button onClick={() => { setEditing(false); setNote(''); }}
                    style={{ display:'flex', alignItems:'center', gap:4, background:'#f5f5f5', color:'#666', border:'1px solid #ddd', borderRadius:7, padding:'8px 14px', fontSize:13, cursor:'pointer' }}>
                    <X size={14}/> Cancel
                  </button>
                </div>
              </div>

            ) : (
              /* ── READ MODE ── */
              <>
                <h1 style={{ fontSize:22, fontWeight:800, marginBottom:'0.5rem', lineHeight:1.3 }}>{event.title}</h1>
                <p style={{ fontSize:14, color:'#555', lineHeight:1.6, marginBottom:'1rem' }}>{event.description}</p>
                {event.extended_description && (
                  <p style={{ fontSize:13, color:'#777', lineHeight:1.6, marginBottom:'1rem' }}>{event.extended_description}</p>
                )}

                <div style={{ display:'flex', flexDirection:'column', gap:12, marginBottom:'1.25rem' }}>
                  {sessions.length > 0 && (
                    <Detail icon="📅" label={`Date & time${tzLabel ? ` (${tzLabel})` : ''}`}>
                      {sessions.map((s: any, i: number) => (
                        <div key={i} style={{ fontSize:13, padding:'0.35rem 0', borderBottom: i < sessions.length-1 ? '1px solid #f0f0f0' : 'none' }}>
                          {formatSessionRange(s.startTime, s.endTime)}
                        </div>
                      ))}
                    </Detail>
                  )}
                  {event.location && (
                    <Detail icon="📍" label="Location">
                      <span style={{ fontSize:13 }}>
                        {event.place_name ? `${event.place_name} · ` : ''}{event.location}
                        {event.room_num && <span style={{ color:'#888' }}> · {event.room_num}</span>}
                      </span>
                    </Detail>
                  )}
                  {event.url_link && (
                    <Detail icon="🌐" label="Online">
                      <a href={event.url_link} target="_blank" rel="noreferrer"
                        style={{ fontSize:13, color:'#3a8c3f', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:4 }}>
                        Join online <ExternalLink size={11}/>
                      </a>
                    </Detail>
                  )}
                  {sponsors.length > 0 && (
                    <Detail icon="🏛" label="Organized by">
                      <span style={{ fontSize:13 }}>{sponsors.join(', ')}</span>
                    </Detail>
                  )}
                  {event.contact_email && (
                    <Detail icon="✉️" label="Contact">
                      <a href={`mailto:${event.contact_email}`} style={{ fontSize:13, color:'#3a8c3f', textDecoration:'none' }}>{event.contact_email}</a>
                      {event.phone && <span style={{ fontSize:13, color:'#666', marginLeft:8 }}>{event.phone}</span>}
                    </Detail>
                  )}
                </div>

                {buttons.length > 0 && (
                  <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:'1.25rem' }}>
                    {buttons.map((b: any, i: number) => (
                      <a key={i} href={b.link} target="_blank" rel="noreferrer"
                        className="btn-primary" style={{ textDecoration:'none', fontSize:13 }}>
                        {b.title}
                      </a>
                    ))}
                  </div>
                )}

                {event.calendar_source_url && (
                  <a href={event.calendar_source_url} target="_blank" rel="noreferrer"
                    style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:12, color:'#aaa', textDecoration:'none' }}>
                    <ExternalLink size={11}/> View original: {event.calendar_source_name}
                  </a>
                )}
              </>
            )}

            {/* ── AI LEARNED banner — shown after a save ── */}
            {lastSaveResult && lastSaveResult.fields.length > 0 && (
              <div style={{ marginTop:'1.25rem', padding:'12px 14px', background:'#f0f7f0', border:'1px solid #c8e6c9', borderRadius:8 }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
                  <BookOpen size={13} color="#3a8c3f"/>
                  <span style={{ fontSize:12, fontWeight:700, color:'#3a8c3f' }}>AI will learn from these corrections next run</span>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                  {lastSaveResult.corrections.map((c, i) => (
                    <div key={i} style={{ fontSize:11, color:'#555', fontFamily:'monospace', background:'white', borderRadius:4, padding:'4px 8px' }}>
                      <span style={{ color:'#888' }}>{c.field}:</span>{' '}
                      <span style={{ color:'#c0392b', textDecoration:'line-through' }}>{c.from || '(empty)'}</span>
                      {' → '}
                      <span style={{ color:'#2a6b2e', fontWeight:600 }}>{c.to || '(empty)'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── RESUBMIT section — shown after save (for logged-in reviewers/admins) ── */}
            {canEdit && lastSaveResult && lastSaveResult.fields.length > 0 && !editing && (
              <div style={{ marginTop:'1rem', paddingTop:'1rem', borderTop:'1px solid #f0f0f0' }}>
                <button onClick={resubmit} disabled={resubmitting}
                  style={{ display:'flex', alignItems:'center', gap:6, background:'#1565c0', color:'white', border:'none', borderRadius:7, padding:'10px 20px', fontSize:13, fontWeight:700, cursor:resubmitting?'wait':'pointer', opacity:resubmitting?0.7:1, width:'100%', justifyContent:'center' }}>
                  <Send size={14}/> {resubmitting ? 'Sending to CommunityHub…' : 'Send updated event to CommunityHub'}
                </button>
              </div>
            )}

            {/* Resubmit result message */}
            {resubmitMsg && (
              <div style={{ marginTop:'0.75rem', padding:'8px 12px', background: resubmitMsg.startsWith('✅') ? '#e8f5e9' : '#fdecea', borderRadius:6, fontSize:13, color: resubmitMsg.startsWith('✅') ? '#2a6b2e' : '#c0392b', fontWeight:600 }}>
                {resubmitMsg}
              </div>
            )}

            {/* Also show resubmit for rejected events even before editing */}
            {canEdit && event.status === 'rejected' && !lastSaveResult && !editing && (
              <div style={{ marginTop:'1.25rem', paddingTop:'1.25rem', borderTop:'1px solid #f0f0f0' }}>
                <p style={{ fontSize:12, color:'#888', marginBottom:8 }}>
                  Edit the fields above and save, then send to CommunityHub.
                </p>
                <button onClick={resubmit} disabled={resubmitting}
                  style={{ display:'flex', alignItems:'center', gap:6, background:'#1565c0', color:'white', border:'none', borderRadius:7, padding:'10px 20px', fontSize:13, fontWeight:700, cursor:resubmitting?'wait':'pointer', opacity:resubmitting?0.7:1 }}>
                  <Send size={14}/> {resubmitting ? 'Sending…' : 'Send to CommunityHub as-is'}
                </button>
              </div>
            )}

          </div>
        </div>

        <p style={{ textAlign:'center', fontSize:11, color:'#aaa', marginTop:'1.5rem' }}>
          AI Events Aggregator · Oberlin Environmental Dashboard
        </p>
      </div>
    </div>
  );
}

function Detail({ icon, label, children }: { icon:string; label:string; children:React.ReactNode }) {
  return (
    <div style={{ display:'flex', gap:10, alignItems:'flex-start' }}>
      <span style={{ fontSize:16, flexShrink:0, marginTop:1 }}>{icon}</span>
      <div>
        <div style={{ fontSize:10, fontWeight:700, color:'#aaa', textTransform:'uppercase', letterSpacing:0.5, marginBottom:2 }}>{label}</div>
        {children}
      </div>
    </div>
  );
}

function EditField({ label, value, onChange, multiline = false }: {
  label: string; value: string; onChange: (v: string) => void; multiline?: boolean;
}) {
  const base: React.CSSProperties = {
    width:'100%', border:'1px solid #ddd', borderRadius:6, padding:'7px 10px',
    fontSize:13, fontFamily:'inherit', color:'#333', background:'#fafafa',
    boxSizing:'border-box', marginTop:4, marginBottom:12,
  };
  return (
    <div>
      <label style={{ fontSize:11, fontWeight:700, color:'#888', textTransform:'uppercase', letterSpacing:0.5 }}>{label}</label>
      {multiline
        ? <textarea value={value} onChange={e => onChange(e.target.value)} rows={3} style={{ ...base, resize:'vertical' }}/>
        : <input    value={value} onChange={e => onChange(e.target.value)} style={base}/>
      }
    </div>
  );
}
