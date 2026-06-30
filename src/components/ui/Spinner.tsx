import { cn } from './cn';
import styles from './Spinner.module.css';

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Visual diameter. @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Accessible label. When provided, the spinner is announced to screen readers
   * via `role="status"`. When omitted, the spinner is treated as decorative
   * (`aria-hidden`) — use this when a parent already conveys the busy state
   * (e.g. a `<Button loading>` sets `aria-busy`).
   */
  label?: string;
}

/**
 * Indeterminate loading indicator. Honours `prefers-reduced-motion` by falling
 * back to a static ring instead of spinning.
 */
export function Spinner({ size = 'md', label, className, ...rest }: SpinnerProps) {
  return (
    <span
      className={cn(styles.spinner, styles[size], className)}
      role={label ? 'status' : undefined}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      <span className={styles.ring} />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}
