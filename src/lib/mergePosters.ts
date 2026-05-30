import sharp from 'sharp';

export const MAX_IMAGE_CDN_URL_LENGTH = 60_000;

const FETCH_TIMEOUT_MS = 10_000;
const MAX_POSTERS = 3;
const MAX_POSTER_WIDTH = 640;
const POSTER_HEIGHT = 480;
const JPEG_QUALITY = 72;

/**
 * Download poster images from `urls`, merge them side-by-side at a fixed height,
 * and return a base64-encoded JPEG data URI ready for `image_cdn_url`.
 *
 * Returns null if no URLs are provided or all fetches fail.
 */
export async function mergePosterImages(urls: string[]): Promise<string | null> {
  if (!urls || urls.length === 0) return null;

  // Download all posters, skip any that fail
  const results = await Promise.all(
    urls.slice(0, MAX_POSTERS).map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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

  const resized = (await Promise.all(
    buffers.map(async (buf) => {
      try {
        return await sharp(buf)
          .resize({
            width: MAX_POSTER_WIDTH,
            height: POSTER_HEIGHT,
            fit: 'inside',
            kernel: sharp.kernel.lanczos3,
          })
          .toBuffer({ resolveWithObject: true });
      } catch {
        return null;
      }
    })
  )).filter((r) => r !== null) as { data: Buffer; info: { width: number; height: number } }[];

  if (resized.length === 0) return null;

  const totalWidth = resized.reduce((sum, r) => sum + r.info.width, 0);
  if (totalWidth <= 0) return null;

  let x = 0;
  const composites = resized.map((r) => {
    const composite = { input: r.data, left: x, top: 0 };
    x += r.info.width;
    return composite;
  });

  try {
    const merged = await sharp({
      create: {
        width: totalWidth,
        height: POSTER_HEIGHT,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .composite(composites)
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    const dataUri = `data:image/jpeg;base64,${merged.toString('base64')}`;
    return Buffer.byteLength(dataUri, 'utf8') <= MAX_IMAGE_CDN_URL_LENGTH ? dataUri : null;
  } catch {
    return null;
  }
}
