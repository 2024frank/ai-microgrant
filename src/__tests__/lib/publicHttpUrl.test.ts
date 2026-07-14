import { isPublicIpAddress, validatePublicHttpUrl } from '@/lib/publicHttpUrl';

describe('public HTTP URL guard', () => {
  it.each([
    '127.0.0.1',
    '10.8.0.2',
    '100.64.0.1',
    '169.254.169.254',
    '172.20.10.2',
    '192.168.1.5',
    '192.0.2.4',
    '198.51.100.9',
    '203.0.113.7',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects the non-public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each([
    '8.8.8.8',
    '93.184.216.34',
    '2606:4700:4700::1111',
  ])('accepts the public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(true);
  });

  it.each([
    'http://localhost/poster.jpg',
    'http://service.internal/poster.jpg',
    'http://127.0.0.1/poster.jpg',
    'http://2130706433/poster.jpg',
    'http://[::ffff:127.0.0.1]/poster.jpg',
    'file:///etc/passwd',
    'https://user:password@cdn.example.com/poster.jpg',
  ])('rejects the unsafe URL %s', value => {
    expect(validatePublicHttpUrl(value).success).toBe(false);
  });

  it('accepts an ordinary public HTTPS URL', () => {
    const result = validatePublicHttpUrl('https://images.example.com/posters/1.jpg');
    expect(result.success).toBe(true);
    if (result.success) expect(result.url.hostname).toBe('images.example.com');
  });
});
