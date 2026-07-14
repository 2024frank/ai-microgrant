import { getSharp } from '@/lib/sharp';
import {
  fetchPublicImage,
  loadImageAsJpeg,
  SafeImageError,
} from '@/lib/safeRemoteImage';

jest.mock('@/lib/sharp', () => ({ getSharp: jest.fn() }));

const PUBLIC_ADDRESS = { address: '93.184.216.34', family: 4 as const };

describe('safe remote image fetching', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects a private DNS answer without opening a request', async () => {
    const requestOnce = jest.fn();
    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      requestOnce,
    })).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS' });
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it('fails closed when any DNS answer is non-public', async () => {
    const requestOnce = jest.fn();
    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      resolveHost: async () => [PUBLIC_ADDRESS, { address: '10.0.0.8', family: 4 }],
      requestOnce,
    })).rejects.toMatchObject({ code: 'NON_PUBLIC_ADDRESS' });
    expect(requestOnce).not.toHaveBeenCalled();
  });

  it('applies the timeout to DNS resolution as well as the response body', async () => {
    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      timeoutMs: 10,
      resolveHost: () => new Promise(() => undefined),
      requestOnce: jest.fn(),
    })).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
  });

  it('revalidates a redirect and blocks a redirect to loopback', async () => {
    const resolveHost = jest.fn().mockResolvedValue([PUBLIC_ADDRESS]);
    const requestOnce = jest.fn().mockResolvedValue({
      status: 302,
      headers: { location: 'http://127.0.0.1/private' },
      body: Buffer.alloc(0),
    });

    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      resolveHost,
      requestOnce,
    })).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(resolveHost).toHaveBeenCalledTimes(1);
    expect(requestOnce).toHaveBeenCalledTimes(1);
  });

  it('pins the validated address and accepts a bounded raster response', async () => {
    const body = Buffer.from('image bytes');
    const requestOnce = jest.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'image/png', 'content-length': String(body.length) },
      body,
    });

    const result = await fetchPublicImage('https://images.example.com/poster.png', {
      timeoutMs: 750,
      maxBytes: 100,
      resolveHost: async () => [PUBLIC_ADDRESS],
      requestOnce,
    });

    expect(result).toEqual({
      bytes: body,
      contentType: 'image/png',
      finalUrl: 'https://images.example.com/poster.png',
    });
    expect(requestOnce).toHaveBeenCalledWith(
      expect.any(URL),
      PUBLIC_ADDRESS,
      expect.any(Number),
      100,
    );
    expect(requestOnce.mock.calls[0][2]).toBeGreaterThan(0);
    expect(requestOnce.mock.calls[0][2]).toBeLessThanOrEqual(750);
  });

  it('rejects spoofed non-image content and oversized bodies', async () => {
    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      resolveHost: async () => [PUBLIC_ADDRESS],
      requestOnce: async () => ({
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html>not an image</html>'),
      }),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });

    await expect(fetchPublicImage('https://images.example.com/poster.jpg', {
      maxBytes: 3,
      resolveHost: async () => [PUBLIC_ADDRESS],
      requestOnce: async () => ({
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
        body: Buffer.alloc(4),
      }),
    })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('never returns claimed image bytes when Sharp cannot decode them', async () => {
    const pipeline: any = {};
    pipeline.rotate = jest.fn(() => pipeline);
    pipeline.resize = jest.fn(() => pipeline);
    pipeline.jpeg = jest.fn(() => pipeline);
    pipeline.toBuffer = jest.fn().mockRejectedValue(new Error('bad image'));
    (getSharp as jest.Mock).mockReturnValue(jest.fn(() => pipeline));

    await expect(loadImageAsJpeg('data:image/jpeg;base64,bm90LWltYWdl'))
      .rejects.toEqual(expect.objectContaining<Partial<SafeImageError>>({ code: 'INVALID_IMAGE' }));
  });
});
