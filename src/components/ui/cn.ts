/**
 * Tiny classname joiner — filters out falsy values so conditional classes read
 * cleanly: `cn(styles.btn, active && styles.active, className)`.
 *
 * Deliberately dependency-free (no `clsx`/`classnames`) to keep the UI layer
 * self-contained. Order is preserved, so the consumer's `className` passed last
 * always wins specificity ties.
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
