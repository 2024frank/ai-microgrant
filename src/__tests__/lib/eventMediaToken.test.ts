import { createEventMediaToken, isValidEventMediaToken } from '@/lib/eventMediaToken';

describe('event media tokens', () => {
  beforeEach(() => {
    process.env.MEDIA_PROXY_SECRET = 'test-media-proxy-secret-123';
  });

  it('versions the signed URL by poster content', () => {
    const first = createEventMediaToken('10', 'data:image/jpeg;base64,first');
    const second = createEventMediaToken('10', 'data:image/jpeg;base64,second');

    expect(first).not.toBe(second);
    expect(isValidEventMediaToken('10', first, 'data:image/jpeg;base64,first')).toBe(true);
    expect(isValidEventMediaToken('10', second, 'data:image/jpeg;base64,second')).toBe(true);
    expect(isValidEventMediaToken('11', first, 'data:image/jpeg;base64,first')).toBe(false);
    expect(isValidEventMediaToken('10', first, 'data:image/jpeg;base64,second')).toBe(false);
  });

  it('rejects tampered revisions and signatures', () => {
    const token = createEventMediaToken('10', 'poster');
    const [version, revision, signature] = token.split('.');

    expect(isValidEventMediaToken('10', `${version}.${revision.replace(/^./, 'x')}.${signature}`, 'poster')).toBe(false);
    expect(isValidEventMediaToken('10', `${version}.${revision}.${signature.replace(/^./, 'x')}`, 'poster')).toBe(false);
  });
});
