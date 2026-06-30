import { Skeleton } from './Skeleton';
import { cn } from './cn';
import styles from './DataTable.module.css';

export interface Column<T> {
  /** Stable key — also used as the React key for header/cells. */
  key: string;
  /** Header content. Hide it visually (keep for AT) with `headerHidden`. */
  header: React.ReactNode;
  /** Cell renderer for a row. */
  cell: (row: T, rowIndex: number) => React.ReactNode;
  /** Text alignment. @default 'left' */
  align?: 'left' | 'center' | 'right';
  /** Fixed column width (number = px). */
  width?: number | string;
  /** Prevent wrapping in this column's cells. */
  nowrap?: boolean;
  /** Hide this column below a breakpoint to keep small screens readable. */
  hideBelow?: 'sm' | 'md';
  /** Visually hide the header text (e.g. an actions column) but keep it for AT. */
  headerHidden?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  /** Stable row identity — used as the React key. */
  getRowId: (row: T, index: number) => string | number;
  /** Show skeleton rows instead of data. */
  loading?: boolean;
  /** Number of skeleton rows while `loading`. @default 6 */
  skeletonRows?: number;
  /** Row click handler. When set, rows become keyboard-activatable. */
  onRowClick?: (row: T) => void;
  /** Per-row accessible label for keyboard/AT users (recommended with `onRowClick`). */
  getRowLabel?: (row: T) => string;
  /** Node shown when `data` is empty and not loading (e.g. `<EmptyState />`). */
  empty?: React.ReactNode;
  /** Visually-hidden table caption — describe the table for screen readers. */
  caption?: string;
  className?: string;
}

/**
 * Generic, fully-typed data table. One component handles the states every real
 * table needs: **loading** (skeleton rows that preserve layout), **empty**
 * (caller-supplied placeholder), and **populated**. It scrolls horizontally on
 * narrow viewports and can drop low-priority columns via `column.hideBelow`.
 *
 * Accessibility:
 * - Real `<table>`/`<th scope="col">` semantics; optional visually-hidden caption.
 * - When `onRowClick` is set, rows get `tabIndex`/`Enter`+`Space` activation and
 *   a focus ring. Interactive elements *inside* a cell should call
 *   `e.stopPropagation()` so they aren't swallowed by the row handler. For the
 *   strongest semantics, prefer a real `<a>`/`<button>` in a cell over row click;
 *   row click is supported as a pragmatic convenience.
 *
 * @example
 * <DataTable
 *   data={users}
 *   getRowId={(u) => u.id}
 *   caption="Team members"
 *   columns={[
 *     { key: 'name', header: 'Name', cell: (u) => u.name },
 *     { key: 'role', header: 'Role', cell: (u) => <Badge>{u.role}</Badge> },
 *   ]}
 * />
 */
export function DataTable<T>({
  columns,
  data,
  getRowId,
  loading = false,
  skeletonRows = 6,
  onRowClick,
  getRowLabel,
  empty,
  caption,
  className,
}: DataTableProps<T>) {
  const clickable = Boolean(onRowClick);

  function colClass(col: Column<T>) {
    return cn(
      col.align === 'right' && styles.right,
      col.align === 'center' && styles.center,
      col.nowrap && styles.nowrap,
      col.hideBelow === 'sm' && styles.hideSm,
      col.hideBelow === 'md' && styles.hideMd,
    );
  }

  // Empty state replaces the table entirely (matches the app's convention).
  if (!loading && data.length === 0 && empty != null) {
    return <div className={cn(styles.wrapper, className)}>{empty}</div>;
  }

  return (
    <div className={cn(styles.wrapper, className)}>
      <table className={styles.table} aria-busy={loading || undefined}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(styles.th, colClass(col))}
                style={col.width != null ? { width: col.width } : undefined}
              >
                {col.headerHidden ? <span className="sr-only">{col.header}</span> : col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: skeletonRows }).map((_, r) => (
                <tr key={`skeleton-${r}`} className={styles.row}>
                  {columns.map((col) => (
                    <td key={col.key} className={cn(styles.td, colClass(col))}>
                      <Skeleton height={12} width={`${50 + ((r * 7 + col.key.length * 11) % 45)}%`} />
                    </td>
                  ))}
                </tr>
              ))
            : data.map((row, rowIndex) => (
                <tr
                  key={getRowId(row, rowIndex)}
                  className={cn(styles.row, clickable && styles.clickable)}
                  onClick={clickable ? () => onRowClick!(row) : undefined}
                  tabIndex={clickable ? 0 : undefined}
                  aria-label={clickable ? getRowLabel?.(row) : undefined}
                  onKeyDown={
                    clickable
                      ? (e) => {
                          if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                            e.preventDefault();
                            onRowClick!(row);
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn(styles.td, colClass(col))}>
                      {col.cell(row, rowIndex)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
