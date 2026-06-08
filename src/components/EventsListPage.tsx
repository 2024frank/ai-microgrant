'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { formatDateTime } from '@/lib/timezone';
import { ExternalLink, Search } from 'lucide-react';

const GEO_LABELS: Record<string, string> = {
  hyper_local: 'Hyper-local', city_wide: 'City-wide', county: 'County', regional: 'Regional',
};
const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  pending:     { bg: '#fff3e0', color: '#c05e00' },
  approved:    { bg: '#e8f5e9', color: '#2a6b2e' },
  rejected:    { bg: '#fdecea', color: '#c0392b' },
  resubmitted: { bg: '#e3f2fd', color: '#1565c0' },
};

interface EventsListPageProps {
  status:     'approved' | 'rejected' | 'pending' | 'all';
  title:      string;
  emptyMsg:   string;
}

export default function EventsListPage({ status, title, emptyMsg }: EventsListPageProps) {
  const { user, token, ready } = useAuth();
  const router  = useRouter();
  const [events, setEvents]   = useState<any[]>([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(0);
  const [q, setQ]             = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sources, setSources] = useState<any[]>([]);
  const limit = 25;

  useEffect(() => {
    if (!ready || !token) return;
    fetch('/api/sources', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setSources).catch(() => {});
  }, [ready, token]);

  useEffect(() => {
    if (!ready || !token) return;
    setLoading(true);
    const params = new URLSearchParams({
      status, page: String(page), limit: String(limit), order: 'desc',
    });
    if (q)            params.set('q', q);
    if (sourceFilter) params.set('source_id', sourceFilter);

    fetch(`/api/events?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(d => { setEvents(d.events || []); setTotal(d.pagination?.total || 0); })
      .catch(() => { setEvents([]); setTotal(0); })
      .finally(() => setLoading(false));
  }, [ready, token, status, page, q, sourceFilter]);

  if (!ready || !user) return null;

  function getFirstSession(sessions: any) {
    const s = Array.isArray(sessions) ? sessions : [];
    return s[0] || null;
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token}/>

      <main style={{ flex: 1, padding: '2rem', minWidth: 0 }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 2 }}>{title}</h1>
            <p style={{ fontSize: 13, color: '#888' }}>{total} event{total !== 1 ? 's' : ''}</p>
          </div>

          {/* Filters */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Search */}
            <div style={{ position: 'relative' }}>
              <Search size={13} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: '#aaa' }}/>
              <input
                value={q}
                onChange={e => { setQ(e.target.value); setPage(0); }}
                placeholder="Search events…"
                style={{ paddingLeft: 28, paddingRight: 10, paddingTop: 6, paddingBottom: 6, border: '1.5px solid #ddd', borderRadius: 6, fontSize: 13, outline: 'none', width: 200 }}
              />
            </div>
            {/* Source filter */}
            {sources.length > 0 && (
              <select value={sourceFilter} onChange={e => { setSourceFilter(e.target.value); setPage(0); }}
                style={{ padding: '0.4rem 0.75rem', border: '1.5px solid #ddd', borderRadius: 6, fontSize: 13, outline: 'none', color: sourceFilter ? '#333' : '#aaa' }}>
                <option value="">All sources</option>
                {sources.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>
        </div>

        {/* Table */}
        {loading ? (
          <div style={{ color: '#aaa', fontSize: 14, padding: '3rem', textAlign: 'center' }}>Loading…</div>
        ) : events.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '4rem', color: '#aaa' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>
              {status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '📋'}
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{emptyMsg}</div>
            {q && <div style={{ fontSize: 13 }}>Try clearing your search</div>}
          </div>
        ) : (
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8f9fa', borderBottom: '1px solid #eee' }}>
                  <th style={th}>Title</th>
                  <th style={th}>Source</th>
                  <th style={th}>Date</th>
                  <th style={th}>Geo scope</th>
                  <th style={th}>Status</th>
                  <th style={th}>Added</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev: any) => {
                  const session = getFirstSession(ev.sessions);
                  const st = STATUS_STYLES[ev.status] || STATUS_STYLES.pending;
                  return (
                    <tr key={ev.id}
                      onClick={() => {
                        if (status === 'pending') router.push(`/reviewer/events/${ev.id}`);
                        else router.push(`/events/${ev.id}/detail`);
                      }}
                      style={{ borderBottom: '1px solid #f5f5f5', cursor: 'pointer' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#f8fff8'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = ''; }}>
                      <td style={{ padding: '0.75rem 1rem', maxWidth: 260 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</div>
                        <div style={{ fontSize: 11, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{ev.description}</div>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: '#666', whiteSpace: 'nowrap' }}>{ev.source_name}</td>
                      <td style={{ padding: '0.75rem 1rem', color: '#666', whiteSpace: 'nowrap' }}>
                        {session ? formatDateTime(session.startTime, { short: true, dateOnly: true }) : '—'}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {ev.geo_scope
                          ? <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: '#e8f5e9', color: '#2a6b2e', fontWeight: 600 }}>{GEO_LABELS[ev.geo_scope] || ev.geo_scope}</span>
                          : <span style={{ color: '#ddd' }}>—</span>}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: st.bg, color: st.color, fontWeight: 600 }}>
                          {ev.status}
                        </span>
                      </td>
                      <td style={{ padding: '0.75rem 1rem', color: '#aaa', whiteSpace: 'nowrap', fontSize: 12 }}>
                        {new Date(ev.created_at).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '0.75rem 1rem' }}>
                        {ev.ingested_post_url && (
                          <a href={ev.ingested_post_url} target="_blank" rel="noreferrer"
                            onClick={e => e.stopPropagation()}
                            style={{ color: '#3a8c3f', display: 'flex', alignItems: 'center', gap: 3 }}>
                            <ExternalLink size={13}/>
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {total > limit && (
          <div style={{ display: 'flex', gap: 8, marginTop: '1.5rem', justifyContent: 'center', alignItems: 'center' }}>
            <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} className="btn-ghost" style={{ fontSize: 12 }}>← Prev</button>
            <span style={{ fontSize: 13, color: '#888' }}>Page {page + 1} of {Math.ceil(total / limit)}</span>
            <button onClick={() => setPage(p => p + 1)} disabled={(page + 1) * limit >= total} className="btn-ghost" style={{ fontSize: 12 }}>Next →</button>
          </div>
        )}
      </main>
    </div>
  );
}

const th: React.CSSProperties = {
  padding: '0.75rem 1rem', textAlign: 'left',
  fontSize: 11, fontWeight: 700, color: '#888',
  textTransform: 'uppercase', letterSpacing: 0.5,
};
