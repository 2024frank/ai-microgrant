import { cn } from './cn';
import styles from './Card.module.css';

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  /** Render as a different element (e.g. `'section'`, `'article'`, `'a'`). @default 'div' */
  as?: React.ElementType;
  /** Inner padding. Use `'none'` for flush content like tables. @default 'md' */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Adds hover elevation + pointer affordance (for clickable cards). */
  interactive?: boolean;
}

/**
 * Surface container with the app's standard border + radius. Replaces the
 * global `.card` class with a typed, composable element that supports padding
 * variants, polymorphism (`as`), and an interactive (hover-elevated) mode.
 */
export function Card({
  as: Tag = 'div',
  padding = 'md',
  interactive = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Tag
      className={cn(
        styles.card,
        styles[`pad-${padding}`],
        interactive && styles.interactive,
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
