import { createHash } from 'node:crypto';

const MAX_AUDIT_BYTES = 60_000;

function canonical(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Keep feedback evidence inside MySQL TEXT without storing multi-megabyte blobs. */
export function fieldAuditValue(value: unknown): string {
  const text = canonical(value);
  if (text.startsWith('data:image/')) {
    const bytes = Buffer.byteLength(text, 'utf8');
    const sha256 = createHash('sha256').update(text).digest('hex');
    return `[embedded image redacted; bytes=${bytes}; sha256=${sha256}]`;
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= MAX_AUDIT_BYTES) return text;
  const sha256 = createHash('sha256').update(text).digest('hex');
  const marker = `\n[truncated; chars=${text.length}; bytes=${bytes}; sha256=${sha256}]`;
  const prefixBudget = MAX_AUDIT_BYTES - Buffer.byteLength(marker, 'utf8');
  let prefix = '';
  let prefixBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (prefixBytes + characterBytes > prefixBudget) break;
    prefix += character;
    prefixBytes += characterBytes;
  }
  return `${prefix}${marker}`;
}
