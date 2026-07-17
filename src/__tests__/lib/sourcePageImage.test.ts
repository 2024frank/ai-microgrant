import {
  discoverSourcePageImage,
  discoverSourcePageImageCandidates,
  extractContentImageCandidates,
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

describe('extractContentImageCandidates', () => {
  it('reads body images, honoring lazy-load attributes and skipping chrome', () => {
    const html = `
      <img src="/mt-content/uploads/2026/05/ballgame-photo.jpg" width="1200" height="800">
      <img data-src="/media/lazy-flyer.jpg" src="data:image/svg+xml,placeholder">
      <img src="/assets/site-logo.png" width="600">
      <img src="/img/tiny-thumb.jpg" width="90" height="90">
      <img src="/decor/vector.svg">
    `;
    expect(extractContentImageCandidates(html)).toEqual([
      '/mt-content/uploads/2026/05/ballgame-photo.jpg',
      '/media/lazy-flyer.jpg',
    ]);
  });

  it('takes the first srcset URL when src is a placeholder', () => {
    const html = '<img src="data:image/gif;base64,R0" srcset="/media/photo-640.jpg 640w, /media/photo-1280.jpg 1280w">';
    expect(extractContentImageCandidates(html)).toEqual(['/media/photo-640.jpg']);
  });
});

describe('discoverSourcePageImageCandidates', () => {
  it('falls back to content images when the page declares no share metadata', async () => {
    // The First Church case: real event photos in the body, no og:image.
    const fetcher = jest.fn().mockResolvedValue(htmlResponse(`
      <title>Events</title>
      <img src="/mt-content/uploads/2026/05/pexels-baseball.jpg" width="7008" height="4672">
      <img src="/mt-content/uploads/2025/05/other-photo.jpg" width="1200" height="800">
    `)) as unknown as typeof fetch;
    await expect(discoverSourcePageImageCandidates('https://firstchurch.example.org/events/', fetcher))
      .resolves.toEqual([
        'https://library.example.org/mt-content/uploads/2026/05/pexels-baseball.jpg',
        'https://library.example.org/mt-content/uploads/2025/05/other-photo.jpg',
      ]);
  });

  it('keeps share metadata ahead of content images', async () => {
    const fetcher = jest.fn().mockResolvedValue(htmlResponse(`
      <meta property="og:image" content="https://cdn.example.org/share.jpg">
      <img src="https://cdn.example.org/body.jpg" width="800">
    `)) as unknown as typeof fetch;
    await expect(discoverSourcePageImageCandidates('https://library.example.org/event', fetcher))
      .resolves.toEqual([
        'https://cdn.example.org/share.jpg',
        'https://cdn.example.org/body.jpg',
      ]);
  });
});
