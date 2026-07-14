export type PublicHttpUrlErrorCode =
  | 'invalid_url'
  | 'invalid_protocol'
  | 'credentials_not_allowed'
  | 'non_public_host';

export type PublicHttpUrlValidation =
  | { success: true; url: URL }
  | { success: false; code: PublicHttpUrlErrorCode; message: string };

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const bytes = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    ? bytes
    : null;
}

function parseIpv6(value: string): number[] | null {
  let address = value.toLowerCase();
  if (address.startsWith('[') && address.endsWith(']')) {
    address = address.slice(1, -1);
  }
  if (!address || address.includes('%')) return null;

  // Convert an embedded dotted-quad tail into two regular IPv6 groups.
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(address.slice(lastColon + 1));
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    address = `${address.slice(0, lastColon)}:${high}:${low}`;
  }

  if ((address.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if ([...left, ...right].some(group => !/^[0-9a-f]{1,4}$/.test(group))) return null;

  if (!address.includes('::')) {
    if (left.length !== 8) return null;
    return left.map(group => Number.parseInt(group, 16));
  }

  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [
    ...left.map(group => Number.parseInt(group, 16)),
    ...Array.from({ length: zeroCount }, () => 0),
    ...right.map(group => Number.parseInt(group, 16)),
  ];
}

/**
 * Return true only for globally routable IP addresses. This is intentionally
 * fail-closed: loopback, private, link-local, carrier NAT, documentation,
 * benchmark, multicast, reserved, and IPv6 transition ranges are rejected.
 */
export function isPublicIpAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false;
    if (a === 192 && b === 88 && c === 99) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    if (a >= 224) return false;
    return true;
  }

  const ipv6 = parseIpv6(address);
  if (!ipv6) return false;

  // IPv4-compatible and IPv4-mapped addresses inherit the IPv4 decision.
  const mappedPrefix = ipv6.slice(0, 5).every(group => group === 0)
    && (ipv6[5] === 0 || ipv6[5] === 0xffff);
  if (mappedPrefix) {
    const mapped = [ipv6[6] >> 8, ipv6[6] & 0xff, ipv6[7] >> 8, ipv6[7] & 0xff];
    return isPublicIpAddress(mapped.join('.'));
  }

  // Globally routable unicast space is currently 2000::/3. Block special
  // transition and documentation prefixes within it as well.
  if (ipv6[0] < 0x2000 || ipv6[0] > 0x3fff) return false;
  if (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8) return false; // documentation
  if (ipv6[0] === 0x2001 && ipv6[1] === 0x0002) return false; // benchmarking
  if (ipv6[0] === 0x2001 && ipv6[1] >= 0x0010 && ipv6[1] <= 0x001f) return false;
  if (ipv6[0] === 0x2001 && ipv6[1] === 0) return false; // Teredo
  if (ipv6[0] === 0x2002) return false; // 6to4
  return true;
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!host) return false;

  const ipv4 = parseIpv4(host);
  const ipv6 = parseIpv6(host);
  if (ipv4 || ipv6) return isPublicIpAddress(host);

  if (!host.includes('.')) return false;
  const blockedSuffixes = [
    '.localhost', '.local', '.internal', '.home', '.lan', '.arpa', '.onion',
    '.invalid', '.test',
  ];
  return host !== 'localhost' && !blockedSuffixes.some(suffix => host.endsWith(suffix));
}

/**
 * Synchronous first-line validation for any URL that the server may later
 * retrieve. DNS answers still require revalidation immediately before a
 * request; see safeRemoteImage.ts.
 */
export function validatePublicHttpUrl(value: string): PublicHttpUrlValidation {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { success: false, code: 'invalid_url', message: 'must be an absolute URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      success: false,
      code: 'invalid_protocol',
      message: 'must use HTTP or HTTPS',
    };
  }
  if (url.username || url.password) {
    return {
      success: false,
      code: 'credentials_not_allowed',
      message: 'must not include URL credentials',
    };
  }
  if (!isPublicHostname(url.hostname)) {
    return {
      success: false,
      code: 'non_public_host',
      message: 'must use a public internet host',
    };
  }
  return { success: true, url };
}
