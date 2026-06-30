/**
 * UI primitives layer.
 *
 * Import from the barrel so usage stays stable if a component's internal file
 * layout changes:
 *
 *   import { Button, Badge, DataTable } from '@/components/ui';
 *
 * Design tokens (colours, radii, shadows, tone pairs) live as CSS custom
 * properties in `src/app/globals.css`; every component reads from them, so the
 * whole system re-themes from one place. See ./README.md for the architecture,
 * API conventions, and best practices.
 */
export { cn } from './cn';
export type { ClassValue } from './cn';

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { Badge } from './Badge';
export type { BadgeProps, BadgeTone, EventStatus } from './Badge';

export { Card } from './Card';
export type { CardProps } from './Card';

export { Avatar } from './Avatar';
export type { AvatarProps } from './Avatar';

export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Input } from './Input';
export type { InputProps } from './Input';

export { Select } from './Select';
export type { SelectProps } from './Select';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export { Pagination } from './Pagination';
export type { PaginationProps } from './Pagination';

export { DataTable } from './DataTable';
export type { Column, DataTableProps } from './DataTable';
