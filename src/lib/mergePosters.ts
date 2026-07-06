import sharp from 'sharp';

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
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: {
            'Accept': 'image/jpeg,image/png,image/gif,*/*;q=0.5',
            'User-Agent': 'CommunityHub-ImageProxy/1.0',
          },
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

  const HEIGHT = 900;

  const resized = await Promise.all(
    buffers.map((buf) =>
      sharp(buf)
        .resize({ height: HEIGHT, kernel: sharp.kernel.lanczos3 })
        .toBuffer({ resolveWithObject: true })
    )
  );

  const totalWidth = resized.reduce((sum, r) => sum + r.info.width, 0);

  let x = 0;
  const composites = resized.map((r) => {
    const composite = { input: r.data, left: x, top: 0 };
    x += r.info.width;
    return composite;
  });

  const merged = await sharp({
    create: {
      width: totalWidth,
      height: HEIGHT,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite(composites)
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return `data:image/jpeg;base64,${merged.toString('base64')}`;
}
