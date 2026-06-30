'use client';

import { forwardRef, useId } from 'react';
import { cn } from './cn';
import styles from './Field.module.css';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label. Always render one for accessibility — use `hideLabel` to hide it visually. */
  label?: string;
  /** Visually hide the label while keeping it for screen readers. */
  hideLabel?: boolean;
  /** Error message. Sets `aria-invalid` and is announced via `aria-describedby`. */
  error?: string;
  /** Helper text shown below the field. */
  hint?: string;
  /** Icon rendered inside the field, leading edge. */
  leftIcon?: React.ReactNode;
  /** Icon (or control) rendered inside the field, trailing edge. */
  rightIcon?: React.ReactNode;
  /** Class for the outer wrapper (the `<input>` itself takes `className`). */
  containerClassName?: string;
}

/**
 * Text input with built-in label/hint/error wiring. Generates a stable `id`,
 * associates the label, and links hint/error text via `aria-describedby` +
 * `aria-invalid` so the field is accessible without extra boilerplate.
 *
 * Controlled or uncontrolled — it forwards a ref and spreads native props.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hideLabel = false,
    error,
    hint,
    leftIcon,
    rightIcon,
    id,
    className,
    containerClassName,
    disabled,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn(styles.field, containerClassName)}>
      {label && (
        <label htmlFor={inputId} className={cn(styles.label, hideLabel && 'sr-only')}>
          {label}
        </label>
      )}
      <div
        className={cn(styles.control, error && styles.invalid, disabled && styles.disabled)}
      >
        {leftIcon != null && (
          <span className={cn(styles.affix, styles.left)} aria-hidden>
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={cn(styles.input, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          {...rest}
        />
        {rightIcon != null && (
          <span className={cn(styles.affix, styles.right)} aria-hidden>
            {rightIcon}
          </span>
        )}
      </div>
      {hint && !error && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
});
