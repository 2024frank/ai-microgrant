import { NextRequest } from 'next/server';

jest.mock('@/lib/safeRemoteImage', () => ({
  loadImageAsJpeg: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
}));

import { GET } from '@/app/api/media/library/[file]/route';
import { loadImageAsJpeg } from '@/lib/safeRemoteImage';
import { LIBRARY_POSTERS } from '@/lib/libraryPosters';

function req() {
  return new NextRequest('http://localhost/api/media/library/lego.jpg');
}

describe('GET /api/media/library/[file]', () => {
  beforeEach(() => {
    (loadImageAsJpeg as jest.Mock).mockClear().mockResolvedValue(Buffer.from('jpeg-bytes'));
  });

  it('serves a known poster as JPEG from its allowlisted Locable source', async () => {
    const res = await GET(req(), { params: Promise.resolve({ file: 'lego.jpg' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(loadImageAsJpeg).toHaveBeenCalledWith(LIBRARY_POSTERS['lego'].image);
  });

  it('404s an unknown slug and never fetches (no open proxy)', async () => {
    const res = await GET(req(), { params: Promise.resolve({ file: 'not-a-real-poster.jpg' }) });
    expect(res.status).toBe(404);
    expect(loadImageAsJpeg).not.toHaveBeenCalled();
  });
});
