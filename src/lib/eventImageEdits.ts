export type NormalizedEventImageEdit = {
  imageCdnUrl: string | null;
  imageData: string | null;
  mediaValue: string | null;
};

export function eventImageEditErrorStatus(error: unknown): 413 | 415 | 422 {
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  if (code === 'TOO_LARGE') return 413;
  if (code === 'UNSUPPORTED_TYPE') return 415;
  return 422;
}

/** Normalize the single reviewer-facing image field into the two storage columns. */
export async function normalizeEventImageEdit(value: unknown): Promise<NormalizedEventImageEdit> {
  if (value === null || value === undefined) {
    return { imageCdnUrl: null, imageData: null, mediaValue: null };
  }
  if (typeof value !== 'string') {
    throw new TypeError('Image must be a URL, embedded data URI, or empty');
  }
  const trimmed = value.trim();
  if (!trimmed) return { imageCdnUrl: null, imageData: null, mediaValue: null };
  if (trimmed.startsWith('data:')) {
    // Keep routes that only handle URL/empty edits free from Sharp's native
    // runtime until embedded bytes actually need decoding.
    const { normalizeEmbeddedImageData } = await import('./safeRemoteImage');
    const imageData = await normalizeEmbeddedImageData(trimmed);
    return { imageCdnUrl: null, imageData, mediaValue: imageData };
  }
  return { imageCdnUrl: trimmed, imageData: null, mediaValue: trimmed };
}
