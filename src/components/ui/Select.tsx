'use client';

import { forwardRef, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from './cn';
import styles from './Field.module.css';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** Field label. Use `hideLabel` to keep it for screen readers only. */
  label?: string;
  hideLabel?: boolean;
  error?: string;
  hint?: string;
  /** Optional placeholder rendered as a disabled first option. */
  placeholder?: string;
  containerClassName?: string;
}

/**
 * Native `<select>` styled to match the design system, with the same
 * label/hint/error a11y wiring as {@link Input}. Using the native control keeps
 * keyboard, mobile, and screen-reader behaviour correct for free; pass `<option>`
 * elements as children.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hideLabel = false,
    error,
    hint,
    placeholder,
    id,
    className,
    containerClassName,
    disabled,
    children,
    value,
    defaultValue,
    ...rest
  },
  ref,
) {
  const reactId = useId();
  const selectId = id ?? reactId;
  const hintId = hint ? `${selectId}-hint` : undefined;
  const errorId = error ? `${selectId}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  // Treat an empty value as "placeholder selected" so the placeholder greys out.
  const isPlaceholder =
    placeholder != null && (value === '' || (value == null && defaultValue == null));

  return (
    <div className={cn(styles.field, containerClassName)}>
      {label && (
        <label htmlFor={selectId} className={cn(styles.label, hideLabel && 'sr-only')}>
          {label}
        </label>
      )}
      <div
        className={cn(styles.control, error && styles.invalid, disabled && styles.disabled)}
      >
        <select
          ref={ref}
          id={selectId}
          className={cn(styles.input, styles.select, isPlaceholder && styles.placeholder, className)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          value={value}
          defaultValue={defaultValue}
          {...rest}
        >
          {placeholder != null && (
            <option value="" disabled={rest.required}>
              {placeholder}
            </option>
          )}
          {children}
        </select>
        <span className={cn(styles.affix, styles.right, styles.chevron)} aria-hidden>
          <ChevronDown size={15} />
        </span>
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
