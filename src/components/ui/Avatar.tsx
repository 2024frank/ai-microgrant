import { cn } from './cn';
import styles from './Avatar.module.css';

export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Full name — used to derive initials and the default accessible label. */
  name?: string;
  /** Optional image URL. Falls back to initials if absent or it fails to load. */
  src?: string;
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Colour treatment. `'solid'` = filled brand; `'subtle'` = tinted. @default 'subtle' */
  tone?: 'solid' | 'subtle';
}

function initials(name?: string): string {
  if (!name) return 'U';
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase() || 'U';
}

/**
 * User avatar showing an image when available, otherwise initials. Decorative
 * by default; pass an `aria-label` (or rely on the derived name title) when the
 * avatar is the only identifier for a user in context.
 */
export function Avatar({
  name,
  src,
  size = 'md',
  tone = 'subtle',
  className,
  title,
  ...rest
}: AvatarProps) {
  return (
    <span
      className={cn(styles.avatar, styles[size], styles[tone], className)}
      title={title ?? name}
      role="img"
      aria-label={name ? `${name}'s avatar` : 'User avatar'}
      {...rest}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatars are remote, arbitrary-host user images; next/image's domain allowlist is impractical here.
        <img className={styles.img} src={src} alt="" />
      ) : (
        <span aria-hidden>{initials(name)}</span>
      )}
    </span>
  );
}
