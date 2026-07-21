'use client';

import Link from 'next/link';
import { AlertCircle, ArrowRight, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Button({ variant = 'primary', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <button className={`cal-button cal-button--${variant} ${className}`} {...props}/>;
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`cal-badge cal-badge--${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ['completed', 'approved', 'submitted', 'active', 'ready', 'unrestricted'].includes(status)
    ? 'success' : ['failed', 'rejected', 'stopped', 'suspended', 'auto_rejected'].includes(status)
      ? 'danger' : ['running', 'pending', 'discovering', 'paused', 'stale', 'restricted'].includes(status) ? 'warning' : 'neutral';
  return <Badge tone={tone}><span className="cal-status-dot"/>{status.replaceAll('_', ' ')}</Badge>;
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`cal-card ${className}`}>{children}</section>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <header className="cal-page-header"><div>{eyebrow && <p className="cal-eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p className="cal-page-description">{description}</p>}</div>{actions && <div className="cal-page-actions">{actions}</div>}</header>;
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body: string; action?: ReactNode }) {
  return <div className="cal-empty"><div className="cal-empty__icon">{icon || <ArrowRight size={20}/>}</div><h3>{title}</h3><p>{body}</p>{action}</div>;
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return <div className="cal-skeleton" aria-label="Loading">{Array.from({ length: rows }).map((_, i) => <span key={i} style={{ width: `${96 - i * 7}%` }}/>)}</div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="cal-error"><AlertCircle size={20}/><div><strong>Could not load this view</strong><p>{message}</p></div>{retry && <Button variant="secondary" onClick={retry}><RefreshCw size={15}/>Retry</Button>}</div>;
}

export function LoadingButton({ busy, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return <Button {...props} disabled={busy || props.disabled}>{busy && <LoaderCircle className="cal-spin" size={16}/>} {children}</Button>;
}

export function Kpi({ label, value, foot, href, icon }: { label: string; value: ReactNode; foot: string; href: string; icon: ReactNode }) {
  return <Link href={href} className="cal-kpi"><div className="cal-kpi__top"><span>{label}</span><span className="cal-kpi__icon">{icon}</span></div><strong>{value}</strong><span className="cal-kpi__foot">{foot}<ArrowRight size={13}/></span></Link>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="cal-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Modal({ title, children, close }: { title: string; children: ReactNode; close: () => void }) {
  return <div className="cal-modal" role="dialog" aria-modal="true" aria-label={title}><button className="cal-modal__backdrop" onClick={close} aria-label="Close dialog"/><div className="cal-modal__panel"><div className="cal-modal__header"><h2>{title}</h2><Button variant="ghost" onClick={close}>Close</Button></div>{children}</div></div>;
}
