'use client';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Image from 'next/image';
import { ExternalLink } from 'lucide-react';
import { formatSessionRange, getTimezoneLabel } from '@/lib/timezone';

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
  const [tzLabel] = useState(getTimezoneLabel);

  useEffect(() => {
    fetch(`/api/events/${id}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(setEvent)
      .catch(() => setError('Event not found'))
      .finally(() => setLoading(false));
  }, [id]);

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
        <div style={{ fontSize:13, color:'#888', marginTop:4 }}>This link may be invalid or the event was removed.</div>
      </div>
    </div>
  );

  const sessions = Array.isArray(event.sessions) ? event.sessions : [];
  const sponsors = Array.isArray(event.sponsors)  ? event.sponsors  : [];
  const buttons  = Array.isArray(event.buttons)   ? event.buttons   : [];
  const status   = STATUS_STYLES[event.status] || STATUS_STYLES.pending;

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
            </div>

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
