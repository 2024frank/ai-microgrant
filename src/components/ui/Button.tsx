import { forwardRef } from 'react';
import { cn } from './cn';
import { Spinner } from './Spinner';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'subtle';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. @default 'primary' */
  variant?: ButtonVariant;
  /** @default 'md' */
  size?: ButtonSize;
  /** Shows a spinner, disables interaction, and sets `aria-busy`. */
  loading?: boolean;
  /** Optional label shown in place of children while `loading`. */
  loadingText?: string;
  /** Icon rendered before the label (decorative — give the button real text). */
  leftIcon?: React.ReactNode;
  /** Icon rendered after the label. */
  rightIcon?: React.ReactNode;
  /** Stretch to the width of the container. */
  fullWidth?: boolean;
}

/**
 * The primary action primitive. Renders a real `<button>` so it is keyboard-
 * and AT-accessible by default. Notes:
 * - `type` defaults to `"button"` to avoid accidental form submits.
 * - `loading` disables the button and exposes `aria-busy`; the spinner is
 *   decorative because the disabled+busy state already communicates progress.
 * - Forwards a ref and spreads native button props, so it composes anywhere a
 *   `<button>` would (forms, menus, `onClick`, `aria-*`, `data-*`).
 *
 * For navigation, wrap a Next `<Link>` or pass an anchor's props to the parent;
 * this component is intentionally a button, not a polymorphic element, to keep
 * the accessibility contract unambiguous.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    loadingText,
    leftIcon,
    rightIcon,
    fullWidth = false,
    type = 'button',
    className,
    children,
    disabled,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        styles.btn,
        styles[variant],
        styles[size],
        fullWidth && styles.fullWidth,
        className,
      )}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === 'lg' ? 'md' : 'sm'} className={styles.affix} />
      ) : (
        leftIcon != null && (
          <span className={styles.affix} aria-hidden>
            {leftIcon}
          </span>
        )
      )}
      <span className={styles.label}>
        {loading && loadingText ? loadingText : children}
      </span>
      {!loading && rightIcon != null && (
        <span className={styles.affix} aria-hidden>
          {rightIcon}
        </span>
      )}
    </button>
  );
});
