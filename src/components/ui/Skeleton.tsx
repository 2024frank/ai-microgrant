import { cn } from './cn';
import styles from './Skeleton.module.css';

export interface SkeletonProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Width — number (px) or any CSS length. @default '100%' */
  width?: number | string;
  /** Height — number (px) or any CSS length. @default '1em' */
  height?: number | string;
  /** Border radius — number (px) or CSS length. Ignored when `circle`. */
  radius?: number | string;
  /** Render a perfect circle (uses `width` as the diameter). */
  circle?: boolean;
}

const len = (v: number | string | undefined): string | undefined =>
  typeof v === 'number' ? `${v}px` : v;

/**
 * Content placeholder for loading states. Prefer this over a bare "Loading…"
 * string for tables, cards and lists — it preserves layout and reduces
 * perceived latency. Decorative by default (`aria-hidden`); announce the
 * surrounding region's busy state with `aria-busy` on the container instead.
 */
export function Skeleton({
  width = '100%',
  height = '1em',
  radius,
  circle = false,
  className,
  style,
  ...rest
}: SkeletonProps) {
  return (
    <span
      aria-hidden
      className={cn(styles.skeleton, className)}
      style={{
        width: circle ? len(height) : len(width),
        height: len(height),
        borderRadius: circle ? '50%' : len(radius) ?? 'var(--radius-sm)',
        ...style,
      }}
      {...rest}
    />
  );
}
