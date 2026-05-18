'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, ClipboardList, CheckCircle, XCircle,
  Database, BarChart2, Shield, Settings, LogOut, Eye,
  RefreshCw, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';

interface SidebarProps {
  role:   'admin' | 'reviewer';
  name:   string;
  email?: string;
  token?: string;
}

export default function Sidebar({ role, name, email, token }: SidebarProps) {
  const path = usePathname();
  const [pendingCount, setPendingCount]           = useState<number | null>(null);
  const [previewAsReviewer, setPreviewAsReviewer] = useState(false);
  const [collapsed, setCollapsed]                 = useState(false);
  const isActive = (href: string) => path === href || path.startsWith(href + '/');
  const effectiveRole = role === 'admin' && previewAsReviewer ? 'reviewer' : role;

  useEffect(() => {
    if (!token) return;
    fetch('/api/review/queue?limit=1', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => setPendingCount(d.total ?? 0)).catch(() => {});
  }, [token, path]);

  function signOut() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  }

  const w = collapsed ? 56 : 224;

  return (
    <aside style={{
      width: w, minWidth: w, minHeight: '100vh',
      borderRight: '1px solid #e8f0e8',
      background: previewAsReviewer ? '#f8fff8' : '#fff',
      display: 'flex', flexDirection: 'column', flexShrink: 0,
      overflow: 'hidden',
      transition: 'width 0.2s ease, min-width 0.2s ease',
    }}>

      {/* Logo row */}
      <div style={{
        padding: collapsed ? '1rem 0.75rem' : '1rem',
        borderBottom: '1px solid #e8f5e9',
        display: 'flex', alignItems: 'center',
        gap: collapsed ? 0 : 10, flexShrink: 0,
        justifyContent: collapsed ? 'center' : 'flex-start',
      }}>
        <Image src="/logo.png" alt="AI Events Aggregator" width={32} height={32} style={{ borderRadius: 4, flexShrink: 0 }}/>
        {!collapsed && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35, whiteSpace: 'nowrap' }}>AI EVENTS</div>
            <div style={{ fontSize: 10, fontWeight: 800, color: '#3a8c3f', letterSpacing: 0.8, lineHeight: 1.35, whiteSpace: 'nowrap' }}>AGGREGATOR</div>
            <div style={{ fontSize: 9, color: '#bbb', marginTop: 1 }}>CommunityHub</div>
          </div>
        )}
      </div>

      {/* Reviewer preview banner */}
      {previewAsReviewer && !collapsed && (
        <div style={{ background: '#fff3cd', borderBottom: '1px solid #ffc107', padding: '0.4rem 0.75rem', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <Eye size={11} color="#856404"/>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#856404', whiteSpace: 'nowrap' }}>REVIEWER VIEW</span>
        </div>
      )}

      {/* Nav */}
      <nav style={{ flex: 1, padding: '0.625rem 0.375rem', overflowY: 'auto', overflowX: 'hidden' }}>
        <NavItem href={effectiveRole === 'admin' ? '/admin/stats' : '/reviewer/dashboard'}
          icon={<LayoutDashboard size={16}/>} label="Dashboard"
          active={isActive('/admin/stats') || isActive('/reviewer/dashboard')}
          collapsed={collapsed}/>
        <NavItem href="/reviewer/queue" icon={<ClipboardList size={16}/>} label="Needs Review"
          active={isActive('/reviewer/queue')} collapsed={collapsed}
          badge={pendingCount !== null && pendingCount > 0 ? pendingCount : undefined}/>
        <NavItem href="/events/approved" icon={<CheckCircle size={16}/>} label="Approved"
          active={isActive('/events/approved')} collapsed={collapsed}/>
        <NavItem href="/events/rejected" icon={<XCircle size={16}/>} label="Rejected"
          active={isActive('/events/rejected')} collapsed={collapsed}/>

        {effectiveRole === 'admin' && (
          <>
            <div style={{ borderTop: '1px solid #f0f0f0', margin: '0.5rem 0.25rem' }}/>
            {!collapsed && <div style={{ fontSize: 9, fontWeight: 700, color: '#ccc', textTransform: 'uppercase', letterSpacing: 1, padding: '0 0.5rem 0.25rem', whiteSpace: 'nowrap' }}>Admin</div>}
            <NavItem href="/admin/sources"   icon={<Database size={16}/>}  label="Event Sources"  active={isActive('/admin/sources')}  collapsed={collapsed}/>
            <NavItem href="/admin/analytics" icon={<BarChart2 size={16}/>} label="AI Analytics"   active={isActive('/admin/analytics')} collapsed={collapsed}/>
            <NavItem href="/admin/controls"  icon={<Shield size={16}/>}    label="Admin Controls" active={isActive('/admin/controls')}  collapsed={collapsed}/>
          </>
        )}

        <div style={{ borderTop: '1px solid #f0f0f0', margin: '0.5rem 0.25rem' }}/>
        <NavItem href="/settings" icon={<Settings size={16}/>} label="Settings"
          active={isActive('/settings')} collapsed={collapsed}/>

        {/* Collapse toggle in nav */}
        <button onClick={() => setCollapsed(c => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{
            width: '100%', padding: '0.45rem',
            borderRadius: 7, border: 'none', background: 'none',
            cursor: 'pointer', color: '#bbb',
            display: 'flex', alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            gap: 8, marginTop: 4,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#f0f0f0'; e.currentTarget.style.color = '#3a8c3f'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = '#bbb'; }}
        >
          {collapsed ? <PanelLeftOpen size={16}/> : <><PanelLeftClose size={16}/><span style={{ fontSize: 13 }}>Collapse</span></>}
        </button>
      </nav>

      {/* Admin preview toggle — only when expanded */}
      {role === 'admin' && !collapsed && (
        <div style={{ padding: '0.5rem 0.625rem', borderTop: '1px solid #f5f5f5', flexShrink: 0 }}>
          <button onClick={() => setPreviewAsReviewer(p => !p)} style={{
            width: '100%', padding: '0.4rem 0.75rem', borderRadius: 7,
            border: `1.5px solid ${previewAsReviewer ? '#ffc107' : '#e0e0e0'}`,
            background: previewAsReviewer ? '#fff3cd' : 'white',
            color: previewAsReviewer ? '#856404' : '#888',
            fontSize: 11, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            whiteSpace: 'nowrap',
          }}>
            {previewAsReviewer ? <><RefreshCw size={11}/> Back to admin</> : <><Eye size={11}/> Preview as reviewer</>}
          </button>
        </div>
      )}

      {/* User footer */}
      <div style={{
        padding: collapsed ? '0.75rem 0' : '0.75rem 1rem',
        borderTop: '1px solid #eee', flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        alignItems: collapsed ? 'center' : 'flex-start', gap: 6,
      }}>
        {/* Avatar — always shown */}
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          background: role === 'admin' ? '#3a8c3f' : '#e8f5e9',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 700,
          color: role === 'admin' ? 'white' : '#3a8c3f', flexShrink: 0,
          cursor: collapsed ? 'default' : 'default',
        }} title={collapsed ? `${name} (${role})` : undefined}>
          {name?.[0]?.toUpperCase() ?? 'U'}
        </div>

        {!collapsed && (
          <>
            <div style={{ minWidth: 0, width: '100%' }}>
              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
              {email && <div style={{ fontSize: 10, color: '#aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{email}</div>}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20, background: role === 'admin' ? '#e8f5e9' : '#f0f0f0', color: role === 'admin' ? '#2a6b2e' : '#666' }}>
                {role === 'admin' ? <Shield size={9}/> : <Eye size={9}/>} {role}
              </span>
              <button onClick={signOut} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                <LogOut size={12}/> Sign out
              </button>
            </div>
          </>
        )}

        {collapsed && (
          <button onClick={signOut} title="Sign out" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ccc', padding: 0 }}>
            <LogOut size={13}/>
          </button>
        )}
      </div>
    </aside>
  );
}

function NavItem({ href, icon, label, active, collapsed, badge }: {
  href: string; icon: React.ReactNode; label: string;
  active: boolean; collapsed: boolean; badge?: number;
}) {
  return (
    <Link href={href} title={collapsed ? label : undefined} style={{
      display: 'flex', alignItems: 'center',
      gap: collapsed ? 0 : 8,
      padding: collapsed ? '0.5rem' : '0.45rem 0.75rem',
      borderRadius: 7, marginBottom: 1,
      fontSize: 13, textDecoration: 'none',
      justifyContent: collapsed ? 'center' : 'flex-start',
      background: active ? '#e8f5e9' : 'transparent',
      color:      active ? '#2a6b2e' : '#555',
      fontWeight: active ? 600 : 400,
      position: 'relative',
      transition: 'background 0.1s',
    }}>
      <span style={{ flexShrink: 0 }}>{icon}</span>
      {!collapsed && <span style={{ flex: 1, whiteSpace: 'nowrap' }}>{label}</span>}
      {!collapsed && badge !== undefined && (
        <span style={{ background: '#3a8c3f', color: 'white', borderRadius: 20, padding: '1px 7px', fontSize: 10, fontWeight: 700 }}>
          {badge > 99 ? '99+' : badge}
        </span>
      )}
      {collapsed && badge !== undefined && (
        <span style={{ position: 'absolute', top: 4, right: 4, background: '#3a8c3f', color: 'white', borderRadius: '50%', width: 14, height: 14, fontSize: 8, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </Link>
  );
}
