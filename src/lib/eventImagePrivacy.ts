import { fieldAuditValue } from './fieldAuditValue';

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Never persist a multi-megabyte poster inside permanent review evidence. */
export function boundedEventSnapshot(value: unknown): Record<string, unknown> {
  const event = asRecord(value);
  const { image_data: imageData, ...snapshot } = event;
  if (typeof imageData === 'string' && imageData) {
    snapshot.image_data_redacted = fieldAuditValue(imageData);
  }
  return snapshot;
}

/** Staff JSON uses the authenticated image endpoint instead of inline blobs. */
export function eventWithoutImageData<T extends Record<string, unknown>>(event: T): Omit<T, 'image_data'> & {
  has_image_data: boolean;
} {
  const { image_data: imageData, ...safe } = event;
  return {
    ...safe,
    has_image_data: Boolean(event.has_image_data)
      || (typeof imageData === 'string' && imageData.length > 0),
  } as Omit<T, 'image_data'> & { has_image_data: boolean };
}
