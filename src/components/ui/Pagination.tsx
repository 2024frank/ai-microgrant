import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';
import styles from './Pagination.module.css';

export interface PaginationProps {
  /** Current page, **0-indexed** (matches the app's existing convention). */
  page: number;
  /** Total number of pages. */
  pageCount: number;
  /** Called with the next 0-indexed page when prev/next is pressed. */
  onPageChange: (page: number) => void;
  className?: string;
  /** Accessible label for the nav landmark. @default 'Pagination' */
  label?: string;
}

/**
 * Prev / "Page X of Y" / Next control. Renders nothing when there is a single
 * page (or fewer). Wrapped in a labelled `<nav>` and disables the prev/next
 * buttons at the bounds so keyboard and AT users can't over-step the range.
 */
export function Pagination({
  page,
  pageCount,
  onPageChange,
  className,
  label = 'Pagination',
}: PaginationProps) {
  if (pageCount <= 1) return null;

  const atStart = page <= 0;
  const atEnd = page >= pageCount - 1;

  return (
    <nav className={cn(styles.pagination, className)} aria-label={label}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPageChange(page - 1)}
        disabled={atStart}
        leftIcon={<ChevronLeft size={14} />}
      >
        Prev
      </Button>
      <span className={styles.status} aria-live="polite">
        Page {page + 1} of {pageCount}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onPageChange(page + 1)}
        disabled={atEnd}
        rightIcon={<ChevronRight size={14} />}
      >
        Next
      </Button>
    </nav>
  );
}
