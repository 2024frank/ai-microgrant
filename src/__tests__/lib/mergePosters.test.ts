jest.mock('@/lib/safeRemoteImage', () => ({
  loadImageAsJpeg: jest.fn(),
  MAX_SAFE_IMAGE_BYTES: 5 * 1024 * 1024,
}));

jest.mock('@/lib/sharp', () => ({
  getSharp: jest.fn(),
}));

import { getSharp } from '@/lib/sharp';
import {
  loadImageAsJpeg,
  MAX_SAFE_IMAGE_BYTES,
} from '@/lib/safeRemoteImage';
import { MAX_POSTER_IMAGES, mergePosterImages } from '@/lib/mergePosters';

function installSharpMock(encodedOutputs: Buffer[]) {
  const qualities: number[] = [];
  const resize = jest.fn();
  const composite = jest.fn();
  const outputs = [...encodedOutputs];

  const sharpFactory: any = jest.fn((input: unknown) => {
    if (
      input
      && typeof input === 'object'
      && !Buffer.isBuffer(input)
      && 'create' in input
    ) {
      const canvas: any = {};
      canvas.composite = composite.mockImplementation(() => canvas);
      canvas.clone = jest.fn(() => {
        const encoder: any = {};
        encoder.jpeg = jest.fn((options: { quality: number }) => {
          qualities.push(options.quality);
          return encoder;
        });
        encoder.toBuffer = jest.fn(async () => outputs.shift() ?? Buffer.alloc(0));
        return encoder;
      });
      return canvas;
    }

    const pipeline: any = {};
    pipeline.resize = resize.mockImplementation(() => pipeline);
    pipeline.jpeg = jest.fn(() => pipeline);
    pipeline.toBuffer = jest.fn(async () => ({
      data: Buffer.from('resized-poster'),
      info: { width: 320, height: 900 },
    }));
    return pipeline;
  });
  sharpFactory.kernel = { lanczos3: 'lanczos3' };
  (getSharp as jest.Mock).mockReturnValue(sharpFactory);

  return { composite, qualities, resize, sharpFactory };
}

describe('mergePosterImages', () => {
  beforeEach(() => {
    (loadImageAsJpeg as jest.Mock).mockReset().mockResolvedValue(Buffer.from('jpeg'));
    (getSharp as jest.Mock).mockReset();
  });

  it('uses the safe decoder, caps the fetch batch, and returns a bounded JPEG', async () => {
    const oversized = Buffer.alloc(MAX_SAFE_IMAGE_BYTES + 1);
    const merged = Buffer.from('bounded-merged-jpeg');
    const sharp = installSharpMock([oversized, merged]);
    const urls = Array.from(
      { length: MAX_POSTER_IMAGES + 2 },
      (_, index) => `https://images.example.com/${index}.jpg`,
    );

    const result = await mergePosterImages(urls);

    expect(loadImageAsJpeg).toHaveBeenCalledTimes(MAX_POSTER_IMAGES);
    for (const url of urls.slice(0, MAX_POSTER_IMAGES)) {
      expect(loadImageAsJpeg).toHaveBeenCalledWith(url, {
        maxBytes: MAX_SAFE_IMAGE_BYTES,
      });
    }
    expect(sharp.resize).toHaveBeenCalledWith(expect.objectContaining({
      width: 1_600,
      height: 900,
      fit: 'inside',
    }));
    expect(sharp.qualities).toEqual([90, 80]);
    expect(Buffer.from(result!.split(',')[1], 'base64')).toEqual(merged);
    expect(Buffer.from(result!.split(',')[1], 'base64').byteLength)
      .toBeLessThanOrEqual(MAX_SAFE_IMAGE_BYTES);
  });

  it('returns null when every candidate is rejected by the safe decoder', async () => {
    installSharpMock([Buffer.from('unused')]);
    (loadImageAsJpeg as jest.Mock).mockRejectedValue(new Error('unsafe image'));

    await expect(mergePosterImages([
      'https://images.example.com/one.jpg',
      'https://images.example.com/two.jpg',
    ])).resolves.toBeNull();
  });

  it('refuses a merged output that remains above the durable byte limit', async () => {
    installSharpMock(
      Array.from({ length: 5 }, () => Buffer.alloc(MAX_SAFE_IMAGE_BYTES + 1)),
    );

    await expect(mergePosterImages([
      'https://images.example.com/poster.jpg',
    ])).resolves.toBeNull();
  });
});
