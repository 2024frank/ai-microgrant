import { createHmac, timingSafeEqual } from 'node:crypto';
import { INTAKE_INVENTORY_URL } from './communityHubInventory';

/**
 * Access control for the intake inventory endpoint. The queue's drafts are
 * unreviewed, and the application's policy is that anonymous readers only
 * see records that completed human review — so the extraction agents fetch
 * the inventory with a read token instead of anonymously. The token is
 * derived from CRON_SECRET (no new secret to provision) and reaches the
 * agents inside their private instructions.
 */
export function intakeInventoryToken(): string | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return null;
  return createHmac('sha256', secret).update('intake-inventory-read').digest('hex').slice(0, 32);
}

export function isIntakeInventoryTokenValid(candidate: string | null): boolean {
  const expected = intakeInventoryToken();
  if (!expected || !candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Swap the base intake inventory URL in prompt text for its tokened form. */
export function withIntakeInventoryToken(text: string): string {
  const token = intakeInventoryToken();
  if (!token || text.includes(`${INTAKE_INVENTORY_URL}?token=`)) return text;
  return text.split(INTAKE_INVENTORY_URL).join(`${INTAKE_INVENTORY_URL}?token=${token}`);
}
