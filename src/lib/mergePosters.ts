import sharp from 'sharp';

export const MAX_IMAGE_CDN_URL_BYTES = 65_535;
const POSTER_MERGE_HEIGHT = 900;
type ResizedPoster = { data: Buffer; info: sharp.OutputInfo };

/**
 * Download poster images from `urls`, merge them side-by-side at a fixed height,
 * and return a base64-encoded JPEG data URI ready for `image_cdn_url`.
 *
 * Returns null if no URLs are provided, all fetches fail, image processing fails,
 * or the resulting data URI would not fit in the raw_events.image_cdn_url TEXT column.
 */
export async function mergePosterImages(
  urls: string[],
  maxDataUriBytes = MAX_IMAGE_CDN_URL_BYTES
): Promise<string | null> {
  if (!urls || urls.length === 0) return null;

  // Download all posters, skip any that fail
  const results = await Promise.all(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        return Buffer.from(await res.arrayBuffer());
      } catch {
        return null;
      }
    })
  );
  const buffers = results.filter((b) => b !== null) as Buffer[];

  if (buffers.length === 0) return null;

  const resizedResults = await Promise.all(
    buffers.map(async (buf) => {
      try {
        return await sharp(buf)
          .resize({ height: POSTER_MERGE_HEIGHT, kernel: sharp.kernel.lanczos3 })
          .toBuffer({ resolveWithObject: true });
      } catch {
        return null;
      }
    })
  );
  const resized = resizedResults.filter((r): r is ResizedPoster => r !== null);

  if (resized.length === 0) return null;

  const totalWidth = resized.reduce((sum, r) => sum + r.info.width, 0);
  if (totalWidth <= 0) return null;

  let x = 0;
  const composites = resized.map((r) => {
    const composite = { input: r.data, left: x, top: 0 };
    x += r.info.width;
    return composite;
  });

  let merged: Buffer;
  try {
    merged = await sharp({
      create: {
        width: totalWidth,
        height: POSTER_MERGE_HEIGHT,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
      .toBuffer();
  } catch {
    return null;
  }

  const dataUri = `data:image/jpeg;base64,${merged.toString('base64')}`;
  return Buffer.byteLength(dataUri, 'utf8') <= maxDataUriBytes ? dataUri : null;
}
