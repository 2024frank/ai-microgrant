const mockFetch = jest.fn();
const mockResizeToBuffer = jest.fn();
const mockComposite = jest.fn();
const mockJpeg = jest.fn();
const mockMergedToBuffer = jest.fn();

(global as any).fetch = mockFetch;

jest.mock('sharp', () => {
  const mockSharp = jest.fn((input: any) => {
    if (input?.create) {
      return { composite: mockComposite };
    }
    return {
      resize: jest.fn(() => ({ toBuffer: mockResizeToBuffer })),
    };
  });
  (mockSharp as any).kernel = { lanczos3: 'lanczos3' };
  return { __esModule: true, default: mockSharp };
});

import { MAX_IMAGE_CDN_URL_LENGTH, mergePosterImages } from '@/lib/mergePosters';

function imageResponse(bytes = [1, 2, 3]) {
  return {
    ok: true,
    arrayBuffer: jest.fn().mockResolvedValue(Uint8Array.from(bytes).buffer),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch.mockResolvedValue(imageResponse());
  mockResizeToBuffer.mockResolvedValue({
    data: Buffer.from('resized'),
    info: { width: 12, height: 20 },
  });
  mockComposite.mockReturnValue({ jpeg: mockJpeg });
  mockJpeg.mockReturnValue({ toBuffer: mockMergedToBuffer });
  mockMergedToBuffer.mockResolvedValue(Buffer.from('merged'));
});

describe('mergePosterImages', () => {
  it('returns a data URI when poster images merge under the DB column limit', async () => {
    const merged = await mergePosterImages(['https://example.test/a.jpg', 'https://example.test/b.jpg']);

    expect(merged).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.byteLength(merged || '', 'utf8')).toBeLessThanOrEqual(MAX_IMAGE_CDN_URL_LENGTH);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null instead of an oversized data URI', async () => {
    mockMergedToBuffer.mockResolvedValueOnce(Buffer.alloc(MAX_IMAGE_CDN_URL_LENGTH));

    const merged = await mergePosterImages(['https://example.test/a.jpg']);

    expect(merged).toBeNull();
  });

  it('returns null when downloaded content cannot be decoded as an image', async () => {
    mockResizeToBuffer.mockRejectedValueOnce(new Error('Input buffer contains unsupported image format'));

    const merged = await mergePosterImages(['https://example.test/not-an-image']);

    expect(merged).toBeNull();
    expect(mockComposite).not.toHaveBeenCalled();
  });
});
