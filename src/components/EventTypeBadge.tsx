import { getEventTypeLabel } from '@/lib/eventTypes';

export default function EventTypeBadge({ value }: { value: unknown }) {
  const normalized = String(value || 'ot').toLowerCase();
  return (
    <span className={`event-type-badge event-type-${normalized}`} title={`Event type code: ${normalized}`}>
      {getEventTypeLabel(value)}
    </span>
  );
}
