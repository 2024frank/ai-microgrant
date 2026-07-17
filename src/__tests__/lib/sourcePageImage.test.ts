import {
  discoverSourcePageImage,
  extractMetaImageCandidates,
} from '@/lib/sourcePageImage';

function htmlResponse(html: string, options: Record<string, unknown> = {}) {
  return {
    ok: true,
    url: 'https://library.example.org/event/storytime',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null) },
    text: async () => html,
    ...options,
  };
}

describe('extractMetaImageCandidates', () => {
  it('reads og:image and twitter:image regardless of attribute order', () => {
    const html = `
      <meta property="og:image" content="https://cdn.example.org/poster.jpg">
      <meta content="https://cdn.example.org/tw.jpg" name="twitter:image">
      <meta property="og:title" content="Storytime">
      <link rel="image_src" href="/images/fallback.png">
    `;
    expect(extractMetaImageCandidates(html)).toEqual([
      'https://cdn.example.org/poster.jpg',
      'https://cdn.example.org/tw.jpg',
      '/images/fallback.png',
    ]);
  });

  it('decodes ampersand entities in URLs and returns nothing without share metadata', () => {
    expect(extractMetaImageCandidates(
      '<meta property="og:image" content="https://cdn.example.org/p.jpg?a=1&amp;b=2">',
    )).toEqual(['https://cdn.example.org/p.jpg?a=1&b=2']);
    expect(extractMetaImageCandidates('<p>No share metadata here.</p>')).toEqual([]);
  });
});

describe('discoverSourcePageImage', () => {
  it('returns the first public share image, resolving relative URLs', async () => {
    const fetcher = jest.fn().mockResolvedValue(htmlResponse(
      '<meta property="og:image" content="/media/storytime.jpg">',
    )) as unknown as typeof fetch;
    await expect(discoverSourcePageImage('https://library.example.org/event/storytime', fetcher))
      .resolves.toBe('https://library.example.org/media/storytime.jpg');
  });

  it('returns null for non-HTML responses, fetch failures, and unsafe page URLs', async () => {
    const nonHtml = jest.fn().mockResolvedValue(htmlResponse('', {
      headers: { get: () => 'application/pdf' },
    })) as unknown as typeof fetch;
    await expect(discoverSourcePageImage('https://library.example.org/flyer.pdf', nonHtml))
      .resolves.toBeNull();

    const failing = jest.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch;
    await expect(discoverSourcePageImage('https://library.example.org/event', failing))
      .resolves.toBeNull();

    const never = jest.fn() as unknown as typeof fetch;
    await expect(discoverSourcePageImage('http://localhost/internal', never)).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('skips candidates on non-public hosts', async () => {
    const fetcher = jest.fn().mockResolvedValue(htmlResponse(`
      <meta property="og:image" content="http://127.0.0.1/poster.jpg">
      <meta property="og:image:secure_url" content="https://cdn.example.org/safe.jpg">
    `)) as unknown as typeof fetch;
    await expect(discoverSourcePageImage('https://library.example.org/event', fetcher))
      .resolves.toBe('https://cdn.example.org/safe.jpg');
  });
});
