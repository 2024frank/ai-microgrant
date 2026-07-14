'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  RefreshCcw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import OnboardingTour from '@/components/OnboardingTour';
import { useAuth } from '@/hooks/useAuth';

interface DashboardData {
  pending?: number;
  personal_stats?: Record<string, number | null>;
  assigned_sources?: Array<{
    id: number;
    name: string;
    pending_count: number;
  }>;
  recent_activity?: Array<{
    action: string;
    title: string;
    source_name: string;
    created_at: string;
  }>;
  oldest_pending?: {
    created_at: string;
    source_name: string;
  } | null;
}

const ACTIVITY_META: Record<string, { label: string; tone: string; icon: React.ReactNode }> = {
  approved: {
    label: 'Published',
    tone: 'badge-green',
    icon: <CheckCircle2 size={16} color="var(--green-600)" aria-hidden="true" />,
  },
  rejected: {
    label: 'Rejected',
    tone: 'badge-red',
    icon: <XCircle size={16} color="var(--red-600)" aria-hidden="true" />,
  },
  sent_for_correction: {
    label: 'Correction requested',
    tone: 'badge-amber',
    icon: <RefreshCcw size={16} color="var(--amber-600)" aria-hidden="true" />,
  },
};

export default function ReviewerDashboardPage() {
  const { user, token, ready } = useAuth();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showTour, setShowTour] = useState(false);

  useEffect(() => {
    if (!ready || !token) return;
    let cancelled = false;

    Promise.all([
      fetch('/api/reviewer/dashboard', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(async response => {
        if (!response.ok) throw new Error('Dashboard data could not be loaded.');
        return response.json() as Promise<DashboardData>;
      }),
      fetch('/api/users/me', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(response => response.ok ? response.json() : null),
      fetch('/api/review/queue?limit=1&sort=ingested_asc', {
        headers: { Authorization: `Bearer ${token}` },
      }).then(response => response.ok ? response.json() : null),
    ])
      .then(async ([dashboard, profile, queueSnapshot]) => {
        if (cancelled) return;
        const scopedSources = await Promise.all((dashboard.assigned_sources || []).map(async source => {
          try {
            const response = await fetch(`/api/review/queue?limit=1&source_id=${source.id}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!response.ok) return null;
            const payload = await response.json();
            const pendingCount = Number(payload.total) || 0;
            return pendingCount > 0 ? { ...source, pending_count: pendingCount } : null;
          } catch {
            return null;
          }
        }));
        if (cancelled) return;
        const oldestScoped = queueSnapshot?.events?.[0];
        setData({
          ...dashboard,
          pending: Number(queueSnapshot?.total) || 0,
          oldest_pending: oldestScoped ? {
            created_at: oldestScoped.created_at,
            source_name: oldestScoped.source_name,
          } : null,
          assigned_sources: scopedSources.filter((source): source is NonNullable<typeof source> => source !== null),
        });
        setShowTour(Boolean(profile && !profile.onboarded));
      })
      .catch(fetchError => {
        if (!cancelled) setError(fetchError instanceof Error ? fetchError.message : 'Dashboard data could not be loaded.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [ready, token]);

  if (!ready || !user) return null;

  const stats = data?.personal_stats || {};
  const sources = data?.assigned_sources || [];
  const recent = data?.recent_activity || [];
  const pending = Number(data?.pending) || 0;
  const avgSeconds = Number(stats.avg_time_sec) || 0;

  return (
    <AppShell role={user.role} name={user.name} email={user.email} token={token} workspaceLabel="Reviewer workspace">
      {showTour && (
        <OnboardingTour role="reviewer" token={token} onDone={() => setShowTour(false)} />
      )}

      <main className="page-main page-main--narrow">
        <header className="page-header">
          <div>
            <div className="page-header__eyebrow">Review operations</div>
            <h1>Good to see you, {user.name.split(' ')[0]}</h1>
            <p>Prioritize the oldest records, verify the outgoing payload, and publish only when every requirement is ready.</p>
          </div>
          <div className="page-header__actions">
            <Link href="/reviewer/queue" className="btn-primary">
              Open review queue <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </header>

        {loading ? (
          <div className="loading-state" role="status"><span className="spinner" /> Loading your workspace…</div>
        ) : error ? (
          <div className="alert alert--error" role="alert"><XCircle size={17} aria-hidden="true" /> {error}</div>
        ) : (
          <>
            {pending > 0 ? (
              <Link href="/reviewer/queue" className="queue-callout">
                <div className="queue-callout__body">
                  <span className="queue-callout__icon"><ClipboardCheck size={22} aria-hidden="true" /></span>
                  <span>
                    <span className="queue-callout__title">{pending} {pending === 1 ? 'record needs' : 'records need'} review</span>
                    <span className="queue-callout__meta">
                      {data?.oldest_pending
                        ? `Oldest received ${new Date(data.oldest_pending.created_at).toLocaleDateString()} from ${data.oldest_pending.source_name}`
                        : 'Open the queue to review source evidence and payload readiness.'}
                    </span>
                  </span>
                </div>
                <ArrowRight size={20} aria-hidden="true" />
              </Link>
            ) : (
              <div className="alert alert--success" style={{ marginBottom: 20 }}>
                <ShieldCheck size={18} aria-hidden="true" />
                <span><strong>The assigned queue is clear.</strong> New records will appear here after a source run completes.</span>
              </div>
            )}

            <section className="stats-grid" aria-label="Personal review statistics">
              <StatCard icon={<CheckCircle2 size={16} />} label="Published today" value={Number(stats.approved_today) || 0} />
              <StatCard icon={<XCircle size={16} />} label="Rejected today" value={Number(stats.rejected_today) || 0} />
              <StatCard icon={<ClipboardCheck size={16} />} label="Total reviewed" value={Number(stats.total_reviewed) || 0} />
              <StatCard icon={<Clock3 size={16} />} label="Average review" value={avgSeconds ? `${avgSeconds}s` : '—'} />
            </section>

            <section className="dashboard-grid">
              <div className="card">
                <div className="card__header">
                  <div>
                    <h2 className="card__title">Queue by source</h2>
                    <p className="card__subtitle">Open a focused queue without losing the selected source.</p>
                  </div>
                </div>
                {sources.length === 0 ? (
                  <div className="empty-state" style={{ padding: '32px 16px' }}>
                    <p>No assigned sources have pending records.</p>
                  </div>
                ) : sources.map(source => (
                  <Link
                    key={source.id}
                    href={`/reviewer/queue?source_id=${source.id}`}
                    className="list-row"
                    style={{ textDecoration: 'none' }}
                  >
                    <span className="queue-item__source-mark" style={{ width: 34, height: 34, flex: '0 0 34px' }} aria-hidden="true">
                      {source.name?.[0]?.toUpperCase() || '?'}
                    </span>
                    <span className="list-row__main">
                      <span className="list-row__title">{source.name}</span>
                      <span className="list-row__meta">Review only this source</span>
                    </span>
                    <span className={source.pending_count ? 'badge badge-green tnum' : 'badge badge-gray tnum'}>
                      {source.pending_count}
                    </span>
                    <ArrowRight size={14} color="var(--ink-400)" aria-hidden="true" />
                  </Link>
                ))}
              </div>

              <div className="card">
                <div className="card__header">
                  <div>
                    <h2 className="card__title">Recent decisions</h2>
                    <p className="card__subtitle">Your latest review outcomes and correction requests.</p>
                  </div>
                </div>
                {recent.length === 0 ? (
                  <div className="empty-state" style={{ padding: '32px 16px' }}><p>No review activity yet.</p></div>
                ) : recent.slice(0, 8).map((activity, index) => {
                  const meta = ACTIVITY_META[activity.action] || {
                    label: activity.action,
                    tone: 'badge-gray',
                    icon: <Clock3 size={16} color="var(--ink-500)" />,
                  };
                  return (
                    <div className="list-row" key={`${activity.created_at}-${index}`}>
                      {meta.icon}
                      <div className="list-row__main">
                        <div className="list-row__title">{activity.title}</div>
                        <div className="list-row__meta">{activity.source_name} · {new Date(activity.created_at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
                      </div>
                      <span className={`badge ${meta.tone}`}>{meta.label}</span>
                    </div>
                  );
                })}
              </div>
            </section>

            <div className="alert alert--info" style={{ marginTop: 16 }}>
              <ShieldCheck size={17} aria-hidden="true" />
              <span>Saved field corrections and rejection notes may be included as reviewer-feedback context in later extraction runs. They do not retrain a model, and every result still requires validation.</span>
            </div>
          </>
        )}
      </main>
    </AppShell>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: number | string }) {
  return (
    <div className="stat-card">
      <div className="stat-card__label">{icon}<span>{label}</span></div>
      <div className="stat-card__value tnum">{value}</div>
    </div>
  );
}
