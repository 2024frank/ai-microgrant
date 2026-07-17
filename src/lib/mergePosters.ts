import { getSharp } from './sharp';
import { loadImageAsJpeg, MAX_SAFE_IMAGE_BYTES } from './safeRemoteImage';

export const MAX_POSTER_IMAGES = 4;

const POSTER_HEIGHT = 900;
const MAX_POSTER_WIDTH = 1_600;
const JPEG_QUALITIES = [90, 80, 70, 60, 50] as const;

interface ResizedPoster {
  data: Buffer;
  info: { width: number };
}

/**
 * Download poster images from `urls`, merge them side-by-side at a fixed height,
 * and return a base64-encoded JPEG data URI ready for `image_data`.
 *
 * Returns null if no image can be decoded or the bounded output cannot be made.
 */
export async function mergePosterImages(urls: string[]): Promise<string | null> {
  if (!urls || urls.length === 0) return null;
  const sharp = getSharp();

  // Defense in depth: callers also cap and validate the URL list, but this
  // utility never fetches an unbounded batch and always uses the SSRF-safe,
  // byte-bounded decoder.
  const resized: ResizedPoster[] = [];
  // Decode sequentially so four maximum-size posters cannot make Sharp hold
  // four decompressed pixel buffers at the same time in a serverless process.
  for (const url of urls.slice(0, MAX_POSTER_IMAGES)) {
    try {
      const decoded = await loadImageAsJpeg(url, { maxBytes: MAX_SAFE_IMAGE_BYTES });
      const poster = await sharp(decoded, {
        failOn: 'error',
        limitInputPixels: 40_000_000,
        sequentialRead: true,
      })
        .resize({
          width: MAX_POSTER_WIDTH,
          height: POSTER_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true,
          kernel: sharp.kernel.lanczos3,
        })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true });
      resized.push(poster);
    } catch {
      // Keep processing the remaining posters; the caller reports an issue if
      // no candidate survives the safe decoder.
    }
  }
  if (resized.length === 0) return null;

  const totalWidth = resized.reduce((sum, r) => sum + r.info.width, 0);
  if (
    !Number.isSafeInteger(totalWidth)
    || totalWidth <= 0
    || totalWidth > MAX_POSTER_IMAGES * MAX_POSTER_WIDTH
  ) return null;

  let x = 0;
  const composites = resized.map((r) => {
    const composite = { input: r.data, left: x, top: 0 };
    x += r.info.width;
    return composite;
  });

  const canvas = sharp({
    create: {
      width: totalWidth,
      height: POSTER_HEIGHT,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites);

  // Compress progressively and refuse any result that cannot fit the same
  // durable 5 MB boundary used for single embedded posters.
  for (const quality of JPEG_QUALITIES) {
    const merged = await canvas.clone()
      .jpeg({ quality, chromaSubsampling: '4:2:0' })
      .toBuffer();
    if (merged.byteLength > 0 && merged.byteLength <= MAX_SAFE_IMAGE_BYTES) {
      return `data:image/jpeg;base64,${merged.toString('base64')}`;
    }
  }

  return null;
}
