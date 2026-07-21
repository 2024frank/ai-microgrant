'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Building2, CalendarDays, ChevronDown, Gauge, LogOut, Menu, Moon, Settings, Sparkles, Sun, Users, X, Inbox, Radar } from 'lucide-react';
import { api, initials, PRODUCT_NAME, rows, type Community, type Me } from '@/lib/ai-calendar';
import { Button, Skeleton } from './ui';

type CalendarContextValue = { me: Me; communityId: number | null; setCommunityId: (value: number | null) => void; communities: Community[] };
const CalendarContext = createContext<CalendarContextValue | null>(null);
export function useCalendar() { const value = useContext(CalendarContext); if (!value) throw new Error('useCalendar must be inside CalendarShell'); return value; }

const baseNav = [
  { href: '/dashboard', label: 'Dashboard', icon: Gauge },
  { href: '/review', label: 'Review', icon: Inbox },
  { href: '/sources', label: 'Sources', icon: Radar },
];

export function CalendarShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [dark, setDark] = useState(false);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState<number | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('ai-calendar-theme');
    const preferred = matchMedia('(prefers-color-scheme: dark)').matches;
    const next = stored ? stored === 'dark' : preferred;
    setDark(next); document.documentElement.dataset.calendarTheme = next ? 'dark' : 'light';
  }, []);

  useEffect(() => {
    let active = true;
    api<Me>('/api/me').then(user => {
      if (!active) return;
      setMe(user); setCommunityId(user.communityId); setLoading(false);
      if (user.role === 'platform_admin') api<Community[] | { items: Community[] }>('/api/communities').then(value => setCommunities(rows(value))).catch(() => undefined);
    }).catch(error => {
      if (!active) return;
      if (error && typeof error === 'object' && 'status' in error && error.status === 401) router.replace('/login');
      else setLoading(false);
    });
    return () => { active = false; };
  }, [router]);

  useEffect(() => { setDrawer(false); }, [pathname]);

  const nav = useMemo(() => {
    if (!me) return baseNav;
    return [
      ...baseNav,
      ...(me.role === 'platform_admin' ? [{ href: '/communities', label: 'Communities', icon: Building2 }] : []),
      ...(me.role !== 'reviewer' ? [{ href: '/users', label: 'Users', icon: Users }] : []),
      { href: '/settings', label: 'Settings', icon: Settings },
    ];
  }, [me]);

  function toggleTheme() {
    const next = !dark; setDark(next);
    document.documentElement.dataset.calendarTheme = next ? 'dark' : 'light';
    localStorage.setItem('ai-calendar-theme', next ? 'dark' : 'light');
  }

  async function signOut() { await api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); router.replace('/login'); }

  if (loading || !me) return <div className="cal-boot"><div className="cal-brand-mark"><Sparkles size={22}/></div><Skeleton rows={3}/></div>;

  const sidebar = <>
    <div className="cal-sidebar__brand"><div className="cal-brand-mark"><CalendarDays size={21}/></div><div><strong>{PRODUCT_NAME}</strong><span>Event operations</span></div><button className="cal-icon-button cal-sidebar__close" onClick={() => setDrawer(false)} aria-label="Close navigation"><X size={18}/></button></div>
    <nav className="cal-sidebar__nav" aria-label="Primary navigation">{nav.map(item => { const active = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`)); const Icon = item.icon; return <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}><Icon size={18}/><span>{item.label}</span></Link>; })}</nav>
    <div className="cal-sidebar__user"><div className="cal-avatar">{initials(me)}</div><div><strong>{me.name || me.email.split('@')[0]}</strong><span>{me.role.replaceAll('_', ' ')}</span></div><button className="cal-icon-button" onClick={signOut} aria-label="Sign out"><LogOut size={17}/></button></div>
  </>;

  return <CalendarContext.Provider value={{ me, communityId, setCommunityId, communities }}><div className="cal-shell"><aside className="cal-sidebar">{sidebar}</aside>{drawer && <div className="cal-drawer"><button className="cal-drawer__backdrop" onClick={() => setDrawer(false)} aria-label="Close navigation"/><aside>{sidebar}</aside></div>}<div className="cal-shell__main"><header className="cal-topbar"><button className="cal-icon-button cal-menu-button" onClick={() => setDrawer(true)} aria-label="Open navigation"><Menu size={19}/></button><div className="cal-topbar__context"><span>Workspace</span><strong>{communities.find(c => c.id === communityId)?.name || (me.communityId ? 'Community calendar' : 'All communities')}</strong></div><div className="cal-topbar__actions">{me.role === 'platform_admin' && <label className="cal-community-select"><span className="sr-only">Active community</span><select value={communityId ?? ''} onChange={event => setCommunityId(event.target.value ? Number(event.target.value) : null)}><option value="">All communities</option>{communities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><ChevronDown size={14}/></label>}<Button variant="ghost" onClick={toggleTheme} aria-label={`Use ${dark ? 'light' : 'dark'} theme`}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</Button></div></header><main className="cal-main">{children}</main></div></div></CalendarContext.Provider>;
}
