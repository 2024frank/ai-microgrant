'use client';
import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { ExternalLink, Check, ArrowLeft, Cloud, CloudOff, Loader } from 'lucide-react';
import { getTimezoneLabel } from '@/lib/timezone';

const STATUS_STYLES: Record<string, { bg: string; color: string; label: string }> = {
  pending:     { bg: '#fff3e0', color: '#c05e00', label: 'Pending review' },
  approved:    { bg: '#e8f5e9', color: '#2a6b2e', label: 'Published'      },
  rejected:    { bg: '#fdecea', color: '#c0392b', label: 'Rejected'       },
  resubmitted: { bg: '#e3f2fd', color: '#1565c0', label: 'Resubmitted'    },
};
const GEO_LABELS: Record<string, string> = {
  hyper_local: 'Hyper-local', city_wide: 'City-wide', county: 'County', regional: 'Regional',
};
const REASON_LABELS: Record<string, string> = {
  wrong_audience: 'Wrong audience', bad_date_parse: 'Bad date/time',
  duplicate_missed: 'Duplicate', description_hallucinated: 'Hallucinated description',
  missing_fields: 'Missing fields', wrong_geo_scope: 'Wrong geo scope',
  not_public_event: 'Not public', wrong_post_type: 'Wrong post type',
  bad_location: 'Bad location', field_correction: 'Fields corrected', other: 'Other',
};

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function EventDetailPage() {
  const { id }  = useParams();
  const router  = useRouter();
  const { user, token, ready, getFreshToken } = useAuth();
  const [event, setEvent]         = useState<any>(null);
  const [rejection, setRejection] = useState<any>(null);
  const [edits, setEdits]         = useState<Record<string, any>>({});
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [tzLabel, setTzLabel]     = useState('');
  const [defaultSessionStart]     = useState(() => Math.floor(Date.now() / 1000));
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const pendingEdits = useRef<Record<string, any>>({});

  useEffect(() => {
    setTzLabel(getTimezoneLabel());
    if (!ready || !token) return;
    fetch(`/api/events/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setEvent);
    fetch(`/api/events/${id}/rejection`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null).then(d => { if (d) setRejection(d); }).catch(() => {});
  }, [ready, token, id]);

  const save = useCallback(async (changes: Record<string, any>) => {
    if (!Object.keys(changes).length) return;
    setSaveState('saving');
    try {
      const freshToken = await getFreshToken();
      const res = await fetch(`/api/events/${id}/edit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${freshToken}` },
        body: JSON.stringify({ edits: changes }),
      });
      if (!res.ok) { setSaveState('error'); setTimeout(() => setSaveState('idle'), 3000); return; }
      setEvent((e: any) => ({ ...e, ...changes }));
      setEdits({});
      pendingEdits.current = {};
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2500);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }, [id, getFreshToken]);

  function set(key: string, val: any) {
    const updated = { ...pendingEdits.current, [key]: val };
    pendingEdits.current = updated;
    setEdits(updated);
    setSaveState('saving');
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(updated), 800);
  }

  function saveNow(key: string, val: any) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const updated = { ...pendingEdits.current, [key]: val };
    pendingEdits.current = updated;
    setEdits(updated);
    save(updated);
  }

  function field(key: string) {
    return edits[key] !== undefined ? edits[key] : (event?.[key] ?? '');
  }
  function pj(val: any) {
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val); } catch { return []; }
  }
  // Use local browser time for display — what you type is what gets saved
  // The unix timestamp sent to CommunityHub is always timezone-correct
  function toLocal(unix: number) {
    if (!unix) return '';
    const d = new Date(unix * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fromLocal(str: string) {
    if (!str) return 0;
    return Math.floor(new Date(str).getTime() / 1000);
  }

  if (!ready || !user || !event) return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar role={user?.role || 'reviewer'} name={user?.name || ''} email={user?.email} token={token}/>
      <main style={{ flex: 1, padding: '2rem', color: '#888' }}>{event === null ? 'Loading…' : 'Event not found'}</main>
    </div>
  );

  const sessions = pj(event.sessions);
  const st       = STATUS_STYLES[event.status] || STATUS_STYLES.pending;
  const canEdit  = user.role === 'admin' || event.status !== 'approved';

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token}/>

      <main style={{ flex: 1, padding: '2rem', maxWidth: 800 }}>
        {/* Back + header */}
        <div style={{ marginBottom: '1.25rem' }}>
          <button onClick={() => router.back()} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#888', fontSize: 12, padding: 0, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
            <ArrowLeft size={12}/> Back
          </button>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ background: st.bg, color: st.color, fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 20 }}>{st.label}</span>
                {event.geo_scope && (
                  <span style={{ background: '#e8f5e9', color: '#2a6b2e', fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20 }}>
                    {GEO_LABELS[event.geo_scope] || event.geo_scope}
                  </span>
                )}
                <span style={{ fontSize: 11, color: '#aaa' }}>ID: {event.id} · {event.source_name}</span>
              </div>
              <h1 style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.3 }}>{event.title}</h1>
            </div>

            {/* Save indicator */}
            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, minWidth: 120 }}>
              {saveState === 'idle'   && canEdit && <span style={{ color: '#ccc', fontSize: 11 }}>All fields auto-save</span>}
              {saveState === 'saving' && <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} color="#999"/><span style={{ color: '#999' }}>Saving…</span></>}
              {saveState === 'saved'  && <><Cloud size={13} color="#3a8c3f"/><span style={{ color: '#3a8c3f', fontWeight: 700 }}>✓ Changes saved</span></>}
              {saveState === 'error'  && <><CloudOff size={13} color="#c0392b"/><span style={{ color: '#c0392b', fontWeight: 600 }}>Save failed — retry</span></>}
            </div>
          </div>
        </div>

        {/* Rejection reason */}
        {event.status === 'rejected' && rejection && (
          <div style={{ background: '#fdecea', border: '1px solid #f5c6cb', borderRadius: 8, padding: '1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#c0392b', marginBottom: 8 }}>Rejected</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: rejection.reviewer_note ? 8 : 0 }}>
              {pj(rejection.reason_codes).map((code: string) => (
                <span key={code} style={{ background: 'white', border: '1px solid #f5c6cb', color: '#c0392b', fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 20 }}>
                  {REASON_LABELS[code] || code}
                </span>
              ))}
            </div>
            {rejection.reviewer_note && <div style={{ fontSize: 12, color: '#c0392b', fontStyle: 'italic' }}>&quot;{rejection.reviewer_note}&quot;</div>}
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>{new Date(rejection.created_at).toLocaleDateString()} · {rejection.reviewer_name}</div>
          </div>
        )}

        {/* Published badge */}
        {event.status === 'approved' && event.communityhub_post_id && (
          <div style={{ background: '#e8f5e9', border: '1px solid #c8e6c9', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '1.25rem', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Check size={16} color="#3a8c3f"/>
            <span style={{ fontSize: 13, color: '#2a6b2e', fontWeight: 600 }}>Published to CommunityHub</span>
            <span style={{ fontSize: 11, color: '#aaa', marginLeft: 'auto' }}>Post ID: {event.communityhub_post_id}</span>
          </div>
        )}

        {!canEdit && (
          <div style={{ background: '#f5f5f5', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: 12, color: '#888' }}>
            This event is published — only admins can edit it.
          </div>
        )}

        {/* Fields */}
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

            <Field label="Title">
              <input value={field('title')} onChange={e => set('title', e.target.value)}
                disabled={!canEdit} maxLength={60} style={inputStyle} placeholder="Event title"/>
            </Field>

            <Field label="Short description">
              <textarea value={field('description')} onChange={e => set('description', e.target.value)}
                disabled={!canEdit} maxLength={200} rows={2} style={{ ...inputStyle, resize: 'vertical' }}/>
            </Field>

            <Field label="Long description">
              <textarea value={field('extended_description') || ''} onChange={e => set('extended_description', e.target.value)}
                disabled={!canEdit} maxLength={1000} rows={4} style={{ ...inputStyle, resize: 'vertical' }}/>
            </Field>

            {/* Date & time — always show at least one row */}
            <Field label={`Date & time${tzLabel ? ` · ${tzLabel}` : ''}`}>
              {(() => {
                const curSessions = edits.sessions ? pj(edits.sessions) : sessions;
                const rows = curSessions.length > 0 ? curSessions : [{ startTime: defaultSessionStart, endTime: defaultSessionStart + 7200 }];
                return rows.map((s: any, i: number) => {
                  // handle both camelCase (startTime) and snake_case (start) field names
                  const startTs = s.startTime ?? s.start ?? 0;
                  const endTs   = s.endTime   ?? s.end   ?? 0;
                  return (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
                      <div style={{ flex: 1 }}>
                        <label style={subLabel}>Start</label>
                        <input type="datetime-local"
                          value={startTs ? toLocal(startTs) : ''}
                          disabled={!canEdit}
                          onChange={e => {
                            const updated = [...rows];
                            updated[i] = { ...updated[i], startTime: fromLocal(e.target.value) };
                            set('sessions', updated);
                          }}
                          style={inputStyle}/>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={subLabel}>End</label>
                        <input type="datetime-local"
                          value={endTs ? toLocal(endTs) : ''}
                          disabled={!canEdit}
                          onChange={e => {
                            const updated = [...rows];
                            updated[i] = { ...updated[i], endTime: fromLocal(e.target.value) };
                            set('sessions', updated);
                          }}
                          style={inputStyle}/>
                      </div>
                    </div>
                  );
                });
              })()}
            </Field>

            {/* Location type — instant save on click */}
            <Field label="Location type">
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                {[['ph2','In-person'],['on','Online'],['bo','Hybrid'],['ne','None']].map(([lt, label]) => (
                  <button key={lt} onClick={() => canEdit && saveNow('location_type', lt)}
                    disabled={!canEdit}
                    style={{ padding: '0.35rem 0.75rem', borderRadius: 6, border: '1.5px solid', fontSize: 12, cursor: canEdit ? 'pointer' : 'default',
                      borderColor: field('location_type') === lt ? '#3a8c3f' : '#ddd',
                      background:  field('location_type') === lt ? '#e8f5e9' : 'white',
                      color:       field('location_type') === lt ? '#2a6b2e' : '#666',
                      fontWeight:  field('location_type') === lt ? 700 : 400 }}>
                    {label}
                  </button>
                ))}
              </div>
              {['ph2','bo'].includes(field('location_type')) && (
                <input value={field('location') || ''} onChange={e => set('location', e.target.value)}
                  disabled={!canEdit} style={{ ...inputStyle, marginBottom: 6 }} placeholder="Street address"/>
              )}
              {['on','bo'].includes(field('location_type')) && (
                <input value={field('url_link') || ''} onChange={e => set('url_link', e.target.value)}
                  disabled={!canEdit} style={inputStyle} placeholder="Stream URL"/>
              )}
            </Field>

            {/* Geo scope — instant save on click */}
            <Field label="Geographic scope">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['hyper_local','city_wide','county','regional'] as const).map(gs => (
                  <button key={gs} onClick={() => canEdit && saveNow('geo_scope', gs)}
                    disabled={!canEdit}
                    style={{ padding: '0.35rem 0.75rem', borderRadius: 6, border: '1.5px solid', fontSize: 12, cursor: canEdit ? 'pointer' : 'default',
                      borderColor: field('geo_scope') === gs ? '#3a8c3f' : '#ddd',
                      background:  field('geo_scope') === gs ? '#e8f5e9' : 'white',
                      color:       field('geo_scope') === gs ? '#2a6b2e' : '#666',
                      fontWeight:  field('geo_scope') === gs ? 700 : 400 }}>
                    {GEO_LABELS[gs]}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="Sponsors">
              <input value={pj(field('sponsors')).join(', ')} onChange={e => set('sponsors', e.target.value.split(',').map((s: string) => s.trim()).filter(Boolean))}
                disabled={!canEdit} style={inputStyle} placeholder="Sponsor 1, Sponsor 2"/>
            </Field>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Contact email">
                <input value={field('contact_email') || ''} onChange={e => set('contact_email', e.target.value)}
                  disabled={!canEdit} style={inputStyle} placeholder="contact@example.com"/>
              </Field>
              <Field label="Phone">
                <input value={field('phone') || ''} onChange={e => set('phone', e.target.value)}
                  disabled={!canEdit} style={inputStyle} placeholder="(440) 000-0000"/>
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <Field label="Website">
                <input value={field('website') || ''} onChange={e => set('website', e.target.value)}
                  disabled={!canEdit} style={inputStyle} placeholder="https://…"/>
              </Field>
              <Field label="Room / venue detail">
                <input value={field('room_num') || ''} onChange={e => set('room_num', e.target.value)}
                  disabled={!canEdit} style={inputStyle} placeholder="e.g. Heiser Auditorium"/>
              </Field>
            </div>

            <Field label="Place name">
              <input value={field('place_name') || ''} onChange={e => set('place_name', e.target.value)}
                disabled={!canEdit} style={inputStyle} placeholder="e.g. Apollo Theatre"/>
            </Field>

            <Field label="Event URL / tickets">
              <input value={field('url_link') || ''} onChange={e => set('url_link', e.target.value)}
                disabled={!canEdit} style={inputStyle} placeholder="https://…"/>
            </Field>

            <Field label="Calendar source name">
              <input value={field('calendar_source_name') || ''} onChange={e => set('calendar_source_name', e.target.value)}
                disabled={!canEdit} style={inputStyle}/>
            </Field>

            <Field label="Image URL">
              <input value={field('image_cdn_url') || ''} onChange={e => set('image_cdn_url', e.target.value)}
                disabled={!canEdit} style={{ ...inputStyle, marginBottom: 6 }} placeholder="https://…"/>
              {(field('image_cdn_url') || event.image_cdn_url) && (
                // eslint-disable-next-line @next/next/no-img-element -- reviewer preview accepts arbitrary source hosts
                <img src={field('image_cdn_url') || event.image_cdn_url} alt="" style={{ maxHeight: 100, borderRadius: 6, objectFit: 'cover', marginTop: 4 }}/>
              )}
            </Field>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', paddingTop: 4 }}>
              {event.calendar_source_url && (
                <a href={event.calendar_source_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#3a8c3f', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ExternalLink size={11}/> View source
                </a>
              )}
              {event.ingested_post_url && (
                <a href={event.ingested_post_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#3a8c3f', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <ExternalLink size={11}/> Permalink
                </a>
              )}
            </div>

          </div>
        </div>
      </main>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 10, fontWeight: 700, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = { width: '100%', padding: '0.55rem 0.75rem', border: '1.5px solid #ddd', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', background: 'white', transition: 'border-color 0.15s' };
const subLabel: React.CSSProperties = { fontSize: 10, color: '#aaa', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, display: 'block', marginBottom: 2 };
