import { cn } from './cn';
import styles from './Badge.module.css';

export type BadgeTone = 'green' | 'gray' | 'red' | 'amber' | 'blue';

/** Event review states used across the app. */
export type EventStatus = 'pending' | 'approved' | 'rejected' | 'resubmitted';

const STATUS_TONE: Record<EventStatus, BadgeTone> = {
  pending: 'amber',
  approved: 'green',
  rejected: 'red',
  resubmitted: 'blue',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Colour tone. Ignored when `status` is set (status picks its own tone). */
  tone?: BadgeTone;
  /**
   * Convenience for the event-review domain: sets both the tone and, when no
   * children are provided, the visible label from the status value.
   */
  status?: EventStatus;
  /** Leading icon (decorative). */
  icon?: React.ReactNode;
  /** @default 'md' */
  size?: 'sm' | 'md';
}

/**
 * Compact pill for statuses, counts and labels. Replaces the ad-hoc
 * `STATUS_STYLES`/inline-pill pattern used throughout the app with a single
 * tone-driven primitive.
 */
export function Badge({
  tone,
  status,
  icon,
  size = 'md',
  className,
  children,
  ...rest
}: BadgeProps) {
  const resolvedTone: BadgeTone = status ? STATUS_TONE[status] : tone ?? 'gray';
  const content = children ?? (status ? status : null);

  return (
    <span
      className={cn(styles.badge, styles[resolvedTone], styles[size], className)}
      {...rest}
    >
      {icon != null && (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      )}
      {content}
    </span>
  );
}
