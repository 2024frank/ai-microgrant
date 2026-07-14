'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import Sidebar from './Sidebar';

interface AppShellProps {
  role: 'admin' | 'reviewer';
  name: string;
  email?: string;
  token?: string;
  children: React.ReactNode;
  workspaceLabel?: string;
}

export default function AppShell({
  role,
  name,
  email,
  token,
  children,
  workspaceLabel = 'Community publishing workspace',
}: AppShellProps) {
  const pathname = usePathname();
  const mobileToggleRef = useRef<HTMLButtonElement>(null);
  const wasMobileOpen = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!isMobile) {
      wasMobileOpen.current = false;
      return;
    }
    if (mobileOpen) {
      wasMobileOpen.current = true;
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLAnchorElement>('#app-navigation a')?.focus();
      });
    } else if (wasMobileOpen.current) {
      wasMobileOpen.current = false;
      mobileToggleRef.current?.focus();
    }
  }, [isMobile, mobileOpen]);

  return (
    <div className="app-shell">
      <Sidebar
        role={role}
        name={name}
        email={email}
        token={token}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        navigationHidden={isMobile && !mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      <button
        type="button"
        className="app-shell__overlay"
        data-open={mobileOpen}
        aria-label="Close navigation"
        aria-hidden={!mobileOpen}
        disabled={!mobileOpen}
        tabIndex={mobileOpen ? 0 : -1}
        onClick={() => setMobileOpen(false)}
      />

      <div className="app-shell__body">
        <header className="app-topbar">
          <button
            type="button"
            ref={mobileToggleRef}
            className="app-topbar__toggle app-topbar__toggle--mobile"
            aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
            aria-controls="app-navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(open => !open)}
          >
            <Menu size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="app-topbar__toggle app-topbar__toggle--desktop"
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            aria-controls="app-navigation"
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed
              ? <PanelLeftOpen size={18} aria-hidden="true" />
              : <PanelLeftClose size={18} aria-hidden="true" />}
          </button>
          <div className="app-topbar__identity">
            <span className="app-topbar__mark" aria-hidden="true">CH</span>
            <div>
              <div className="app-topbar__eyebrow">CommunityHub intake</div>
              <div className="app-topbar__name">{workspaceLabel}</div>
            </div>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
