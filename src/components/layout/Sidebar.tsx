'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut as firebaseSignOut } from 'firebase/auth';
import {
  BarChart3,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  Database,
  LayoutDashboard,
  LogOut,
  Hourglass,
  Settings,
  ShieldCheck,
  Users,
  XCircle,
} from 'lucide-react';
import { auth } from '@/lib/firebase';

interface SidebarProps {
  role: 'admin' | 'reviewer';
  name: string;
  email?: string;
  token?: string;
  collapsed?: boolean;
  mobileOpen?: boolean;
  navigationHidden?: boolean;
  onMobileClose?: () => void;
}

interface NotificationItem {
  id: number;
  type?: string;
  title: string;
  message: string;
  created_at: string;
  read_at?: string | null;
  raw_event_id?: number | null;
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

export default function Sidebar({
  role,
  name,
  email,
  token,
  collapsed = false,
  mobileOpen,
  navigationHidden = false,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const notificationsRef = useRef<HTMLDivElement>(null);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const loadPendingCount = useCallback(() => {
    if (!token) return Promise.resolve();
    fetch('/api/review/queue?limit=1', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(response => response.ok ? response.json() : Promise.reject())
      .then(data => setPendingCount(Number(data.total) || 0))
      .catch(() => setPendingCount(null));
    return Promise.resolve();
  }, [token]);

  useEffect(() => {
    if (!token) return;
    void loadPendingCount();
    const interval = window.setInterval(loadPendingCount, 30_000);
    window.addEventListener('review-queue-updated', loadPendingCount);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('review-queue-updated', loadPendingCount);
    };
  }, [token, pathname, loadPendingCount]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const loadNotifications = () => {
      fetch('/api/notifications', {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(response => response.ok ? response.json() : Promise.reject())
        .then(data => {
          if (cancelled) return;
          setNotifications(Array.isArray(data.notifications) ? data.notifications : []);
          setUnreadCount(Number(data.unread) || 0);
        })
        .catch(() => {});
    };
    loadNotifications();
    const interval = window.setInterval(loadNotifications, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [token]);

  useEffect(() => {
    function handlePointer(event: MouseEvent) {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) {
        setNotificationsOpen(false);
      }
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setNotificationsOpen(false);
    }
    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, []);

  const workspaceItems: NavItem[] = [
    {
      href: role === 'admin' ? '/admin/stats' : '/reviewer/dashboard',
      label: 'Overview',
      icon: <LayoutDashboard size={18} aria-hidden="true" />,
    },
    {
      href: '/reviewer/queue',
      label: 'Review queue',
      icon: <ClipboardCheck size={18} aria-hidden="true" />,
      badge: pendingCount && pendingCount > 0 ? pendingCount : undefined,
    },
    {
      href: '/events/submitted',
      label: 'Awaiting CommunityHub',
      icon: <Hourglass size={18} aria-hidden="true" />,
    },
    {
      href: '/events/approved',
      label: 'Published',
      icon: <CheckCircle2 size={18} aria-hidden="true" />,
    },
    {
      href: '/events/rejected',
      label: 'Rejected',
      icon: <XCircle size={18} aria-hidden="true" />,
    },
  ];

  const adminItems: NavItem[] = [
    { href: '/admin/sources', label: 'Sources & runs', icon: <Database size={18} aria-hidden="true" /> },
    { href: '/admin/analytics', label: 'Quality signals', icon: <BarChart3 size={18} aria-hidden="true" /> },
    { href: '/admin/controls', label: 'Team & access', icon: <Users size={18} aria-hidden="true" /> },
  ];

  function isActive(href: string) {
    const overviewAliases = href === '/admin/stats' && pathname === '/reviewer/dashboard';
    return overviewAliases || pathname === href || pathname.startsWith(`${href}/`);
  }

  async function markRead(item: NotificationItem) {
    if (!token) return;
    if (!item.read_at) {
      await fetch(`/api/notifications/${item.id}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
      setNotifications(current => current.map(notification => (
        notification.id === item.id
          ? { ...notification, read_at: new Date().toISOString() }
          : notification
      )));
      setUnreadCount(count => Math.max(0, count - 1));
    }
    if (item.raw_event_id) {
      setNotificationsOpen(false);
      router.push(`/reviewer/events/${item.raw_event_id}`);
    }
  }

  async function signOut() {
    try {
      await firebaseSignOut(auth);
    } finally {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
      router.replace('/login');
    }
  }

  function renderNavItem(item: NavItem) {
    const active = isActive(item.href);
    const badgeDescription = item.badge !== undefined
      ? `${item.badge} ${item.badge === 1 ? 'record' : 'records'} waiting`
      : '';
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`sidebar__link${item.badge !== undefined ? ' sidebar__link--badged' : ''}`}
        aria-current={active ? 'page' : undefined}
        title={collapsed ? `${item.label}${badgeDescription ? ` — ${badgeDescription}` : ''}` : undefined}
        onClick={onMobileClose}
      >
        {item.icon}
        <span className="sidebar__label">{item.label}</span>
        {item.badge !== undefined && (
          <span className="sidebar__badge" aria-label={badgeDescription} title={`${item.label}: ${badgeDescription}`}>
            {item.badge > 99 ? '99+' : item.badge}
          </span>
        )}
        {item.badge !== undefined && (
          <span className="sidebar__compact-queue" aria-hidden="true">Review {item.badge > 99 ? '99+' : item.badge}</span>
        )}
      </Link>
    );
  }

  return (
    <aside
      id="app-navigation"
      className="sidebar"
      data-collapsed={collapsed}
      data-mobile-managed={typeof mobileOpen === 'boolean'}
      data-mobile-open={Boolean(mobileOpen)}
      aria-hidden={navigationHidden || undefined}
      inert={navigationHidden || undefined}
      aria-label="Primary navigation"
    >
      <div className="sidebar__brand">
        <div className="sidebar__logo">
          <Image src="/logo.png" alt="" width={24} height={24} />
        </div>
        <div className="sidebar__brand-copy">
          <p className="sidebar__product">Event Intake</p>
          <div className="sidebar__community">CommunityHub · Oberlin</div>
        </div>
      </div>

      <nav className="sidebar__nav">
        <div className="sidebar__section">
          <div className="sidebar__section-label">Workspace</div>
          {workspaceItems.map(renderNavItem)}
        </div>
        {role === 'admin' && (
          <div className="sidebar__section">
            <div className="sidebar__section-label">Operations</div>
            {adminItems.map(renderNavItem)}
          </div>
        )}
        <div className="sidebar__section">
          <div className="sidebar__section-label">Account</div>
          {renderNavItem({
            href: '/settings',
            label: 'Settings',
            icon: <Settings size={18} aria-hidden="true" />,
          })}
        </div>
      </nav>

      <div className="sidebar__utility" ref={notificationsRef}>
        <button
          type="button"
          className="sidebar__icon-button"
          aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          aria-expanded={notificationsOpen}
          aria-controls="notification-panel"
          onClick={() => setNotificationsOpen(open => !open)}
        >
          <Bell size={18} aria-hidden="true" />
          {unreadCount > 0 && <span className="sidebar__unread">{unreadCount > 9 ? '9+' : unreadCount}</span>}
        </button>

        {notificationsOpen && (
          <div id="notification-panel" className="sidebar__notifications" role="dialog" aria-label="Notifications">
            <div className="sidebar__notifications-header">Notifications</div>
            {notifications.length === 0 ? (
              <div className="sidebar__empty">No notifications yet</div>
            ) : notifications.map(item => (
              <button
                type="button"
                key={item.id}
                className="sidebar__notification"
                data-unread={!item.read_at}
                onClick={() => markRead(item)}
              >
                <span aria-hidden="true">
                  {item.type === 'fix_failed'
                    ? <XCircle size={15} color="var(--red-600)" />
                    : <ShieldCheck size={15} color="var(--green-600)" />}
                </span>
                <span>
                  <span className="sidebar__notification-title">{item.title}</span>
                  <span className="sidebar__notification-copy">{item.message}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar__user">
        <div className="sidebar__avatar" title={name}>{name?.[0]?.toUpperCase() || 'U'}</div>
        <div className="sidebar__user-copy">
          <div className="sidebar__user-name">{name}</div>
          <div className="sidebar__user-meta">{email || role} · {role}</div>
        </div>
        <div className="sidebar__footer-actions">
          <button type="button" className="sidebar__icon-button sidebar__signout" onClick={signOut} title="Sign out" aria-label="Sign out">
            <LogOut size={17} aria-hidden="true" />
          </button>
        </div>
      </div>
    </aside>
  );
}
