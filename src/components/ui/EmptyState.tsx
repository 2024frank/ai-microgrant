import { cn } from './cn';
import styles from './EmptyState.module.css';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Decorative icon or emoji shown above the title. */
  icon?: React.ReactNode;
  /** Required, concise headline (e.g. "No pending events"). */
  title: string;
  /** Optional supporting sentence. */
  description?: React.ReactNode;
  /** Optional call-to-action (e.g. a `<Button>` or clear-filters link). */
  action?: React.ReactNode;
  /** @default 'md' */
  size?: 'sm' | 'md';
}

/**
 * Standard "nothing here" placeholder for empty lists, tables and search
 * results. The icon is decorative; the title is the accessible anchor. Pair
 * with an `action` to give users a way forward (clear filters, create item).
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  size = 'md',
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div className={cn(styles.empty, styles[size], className)} {...rest}>
      {icon != null && (
        <div className={styles.icon} aria-hidden>
          {icon}
        </div>
      )}
      <p className={styles.title}>{title}</p>
      {description != null && <p className={styles.description}>{description}</p>}
      {action != null && <div className={styles.action}>{action}</div>}
    </div>
  );
}
