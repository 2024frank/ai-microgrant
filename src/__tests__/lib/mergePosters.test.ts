import sharp from 'sharp';
import { mergePosterImages } from '@/lib/mergePosters';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

async function makeImageBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  }).png().toBuffer();
}

describe('mergePosterImages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns a JPEG data URI for valid fetched posters', async () => {
    const image = await makeImageBuffer();
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(toArrayBuffer(image)),
    });

    const merged = await mergePosterImages(['https://example.test/poster.png']);

    expect(merged).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('returns null instead of throwing when fetched poster data is not an image', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(toArrayBuffer(Buffer.from('not an image'))),
    });

    await expect(mergePosterImages(['https://example.test/bad-poster'])).resolves.toBeNull();
  });

  it('returns null when the merged data URI would exceed the DB column limit', async () => {
    const image = await makeImageBuffer();
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(toArrayBuffer(image)),
    });

    await expect(mergePosterImages(['https://example.test/poster.png'], 10)).resolves.toBeNull();
  });
});
