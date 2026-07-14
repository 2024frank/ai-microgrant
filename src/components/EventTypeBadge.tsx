const POST_KIND_LABELS: Record<string, string> = {
  ot: 'Event',
  an: 'Announcement',
  jp: 'Job',
};

export default function EventTypeBadge({ value }: { value: unknown }) {
  const normalized = String(value || 'ot').toLowerCase();
  const valid = normalized in POST_KIND_LABELS;
  return (
    <span
      className={`event-type-badge ${valid ? `event-type-${normalized}` : 'event-type-invalid'}`}
      title={valid ? `Post kind code: ${normalized}` : `Unsupported post kind code: ${normalized}`}
    >
      {valid ? POST_KIND_LABELS[normalized] : 'Needs kind mapping'}
    </span>
  );
}
