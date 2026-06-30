'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ExternalLink, Search } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import Sidebar from '@/components/layout/Sidebar';
import { formatDateTime } from '@/lib/timezone';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Input,
  Pagination,
  Select,
  type Column,
  type EventStatus,
} from '@/components/ui';
import styles from './EventsListPage.module.css';

const GEO_LABELS: Record<string, string> = {
  hyper_local: 'Hyper-local',
  city_wide: 'City-wide',
  county: 'County',
  regional: 'Regional',
};

interface EventSession {
  /** Unix timestamp in seconds (see formatDateTime). */
  startTime: number;
}

interface EventRow {
  id: number | string;
  title: string;
  description?: string;
  source_name?: string;
  sessions?: EventSession[] | unknown;
  geo_scope?: string;
  status: EventStatus;
  created_at: string;
  ingested_post_url?: string;
}

interface SourceOption {
  id: number | string;
  name: string;
}

interface EventsListPageProps {
  status: 'approved' | 'rejected' | 'pending' | 'all';
  title: string;
  emptyMsg: string;
}

function getFirstSession(sessions: EventRow['sessions']): EventSession | null {
  const s = Array.isArray(sessions) ? (sessions as EventSession[]) : [];
  return s[0] ?? null;
}

export default function EventsListPage({ status, title, emptyMsg }: EventsListPageProps) {
  const { user, token, ready } = useAuth();
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [sourceFilter, setSourceFilter] = useState('');
  const [sources, setSources] = useState<SourceOption[]>([]);
  const limit = 25;

  useEffect(() => {
    if (!ready || !token) return;
    fetch('/api/sources', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then(setSources)
      .catch(() => {});
  }, [ready, token]);

  useEffect(() => {
    if (!ready || !token) return;
    setLoading(true);
    const params = new URLSearchParams({
      status,
      page: String(page),
      limit: String(limit),
      order: 'desc',
    });
    if (q) params.set('q', q);
    if (sourceFilter) params.set('source_id', sourceFilter);

    fetch(`/api/events?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((d) => {
        setEvents(d.events || []);
        setTotal(d.pagination?.total || 0);
      })
      .catch(() => {
        setEvents([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }, [ready, token, status, page, q, sourceFilter]);

  if (!ready || !user) return null;

  const emptyIcon = status === 'approved' ? '✅' : status === 'rejected' ? '❌' : '📋';

  const columns: Column<EventRow>[] = [
    {
      key: 'title',
      header: 'Title',
      width: 240,
      cell: (ev) => (
        <div className={styles.titleCell}>
          <div className={styles.titleText}>{ev.title}</div>
          {ev.description && <div className={styles.descText}>{ev.description}</div>}
        </div>
      ),
    },
    {
      key: 'source',
      header: 'Source',
      nowrap: true,
      cell: (ev) => <span className={styles.muted}>{ev.source_name}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      nowrap: true,
      hideBelow: 'sm',
      cell: (ev) => {
        const session = getFirstSession(ev.sessions);
        return (
          <span className={styles.muted}>
            {session ? formatDateTime(session.startTime, { short: true, dateOnly: true }) : '—'}
          </span>
        );
      },
    },
    {
      key: 'geo',
      header: 'Geo scope',
      hideBelow: 'md',
      cell: (ev) =>
        ev.geo_scope ? (
          <Badge tone="green" size="sm">
            {GEO_LABELS[ev.geo_scope] || ev.geo_scope}
          </Badge>
        ) : (
          <span className={styles.dash}>—</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (ev) => <Badge status={ev.status} size="sm" />,
    },
    {
      key: 'added',
      header: 'Added',
      nowrap: true,
      hideBelow: 'sm',
      cell: (ev) => (
        <span className={styles.added}>{new Date(ev.created_at).toLocaleDateString()}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Open external link',
      headerHidden: true,
      align: 'right',
      cell: (ev) =>
        ev.ingested_post_url ? (
          <a
            href={ev.ingested_post_url}
            target="_blank"
            rel="noreferrer"
            className={styles.extLink}
            aria-label={`Open original post for ${ev.title}`}
            onClick={(e) => e.stopPropagation()}
          >
            <ExternalLink size={13} />
          </a>
        ) : null,
    },
  ];

  return (
    <div className={styles.page}>
      <Sidebar role={user.role} name={user.name} email={user.email} token={token} />

      <main className={styles.main}>
        <div className={styles.toolbar}>
          <div>
            <h1 className={styles.heading}>{title}</h1>
            <p className={styles.count}>
              {total} event{total !== 1 ? 's' : ''}
            </p>
          </div>

          <div className={styles.filters}>
            <Input
              label="Search events"
              hideLabel
              placeholder="Search events…"
              leftIcon={<Search size={13} />}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(0);
              }}
              containerClassName={styles.searchField}
            />
            {sources.length > 0 && (
              <Select
                label="Filter by source"
                hideLabel
                placeholder="All sources"
                value={sourceFilter}
                onChange={(e) => {
                  setSourceFilter(e.target.value);
                  setPage(0);
                }}
              >
                {sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>

        <DataTable
          data={events}
          getRowId={(ev) => ev.id}
          loading={loading}
          columns={columns}
          caption={title}
          onRowClick={(ev) => router.push(`/reviewer/events/${ev.id}`)}
          getRowLabel={(ev) => `Open ${ev.title}`}
          empty={
            <EmptyState
              icon={emptyIcon}
              title={emptyMsg}
              description={q ? 'No events match your search.' : undefined}
              action={
                q ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setQ('');
                      setPage(0);
                    }}
                  >
                    Clear search
                  </Button>
                ) : undefined
              }
            />
          }
        />

        <Pagination
          className={styles.pagination}
          page={page}
          pageCount={Math.ceil(total / limit)}
          onPageChange={setPage}
        />
      </main>
    </div>
  );
}
