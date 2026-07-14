import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { getSharp } from './sharp';
import { isPublicIpAddress, validatePublicHttpUrl } from './publicHttpUrl';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
]);

export type SafeImageErrorCode =
  | 'INVALID_URL'
  | 'DNS_FAILURE'
  | 'NON_PUBLIC_ADDRESS'
  | 'TOO_MANY_REDIRECTS'
  | 'UPSTREAM_STATUS'
  | 'UPSTREAM_TIMEOUT'
  | 'FETCH_FAILED'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_LARGE'
  | 'INVALID_IMAGE';

export class SafeImageError extends Error {
  constructor(readonly code: SafeImageErrorCode, message: string) {
    super(message);
    this.name = 'SafeImageError';
  }
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

interface ImageResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

type ResolveHost = (hostname: string) => Promise<ResolvedAddress[]>;
type RequestOnce = (
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  maxBytes: number,
) => Promise<ImageResponse>;

export interface SafeImageFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Dependency seams are used by focused tests; production callers omit them. */
  resolveHost?: ResolveHost;
  requestOnce?: RequestOnce;
}

export interface FetchedImage {
  bytes: Buffer;
  contentType: string;
  finalUrl: string;
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SafeImageError('UPSTREAM_TIMEOUT', 'Image request timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SafeImageError('UPSTREAM_TIMEOUT', 'Image request timed out')),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

async function resolveHost(hostname: string): Promise<ResolvedAddress[]> {
  try {
    const answers = await dnsLookup(normalizeHostname(hostname), { all: true, verbatim: true });
    return answers
      .filter(answer => answer.family === 4 || answer.family === 6)
      .map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }));
  } catch {
    throw new SafeImageError('DNS_FAILURE', 'Image host could not be resolved');
  }
}

function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function normalizedContentType(headers: IncomingHttpHeaders): string {
  return headerValue(headers, 'content-type').split(';', 1)[0].trim().toLowerCase();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Execute one HTTP request while pinning the socket lookup to an address that
 * was already checked. This closes the DNS-rebinding gap between validation
 * and connection establishment.
 */
function requestOnce(
  url: URL,
  address: ResolvedAddress,
  timeoutMs: number,
  maxBytes: number,
): Promise<ImageResponse> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const requester = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };

    const req = requester(url, {
      method: 'GET',
      headers: {
        Accept: 'image/jpeg,image/png,image/gif,image/webp,image/avif',
        'User-Agent': 'CommunityHub-ImageProxy/2.0',
      },
      signal: controller.signal,
      // Node's request API normally performs a second DNS lookup. Pin it to
      // the validated result while preserving the original Host header/SNI.
      lookup: ((_hostname: string, options: any, callback: any) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as any,
    }, response => {
      const status = response.statusCode ?? 0;
      if (isRedirect(status)) {
        response.resume();
        finish(() => resolve({ status, headers: response.headers, body: Buffer.alloc(0) }));
        return;
      }

      const contentLength = Number(headerValue(response.headers, 'content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        response.destroy();
        finish(() => reject(new SafeImageError('TOO_LARGE', 'Upstream image is too large')));
        return;
      }

      const chunks: Buffer[] = [];
      let total = 0;
      response.on('data', (chunk: Buffer | Uint8Array) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.byteLength;
        if (total > maxBytes) {
          response.destroy();
          finish(() => reject(new SafeImageError('TOO_LARGE', 'Upstream image is too large')));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        finish(() => resolve({ status, headers: response.headers, body: Buffer.concat(chunks, total) }));
      });
      response.on('error', () => {
        finish(() => reject(new SafeImageError('FETCH_FAILED', 'Image response failed')));
      });
    });

    req.on('error', () => {
      const error = controller.signal.aborted
        ? new SafeImageError('UPSTREAM_TIMEOUT', 'Image request timed out')
        : new SafeImageError('FETCH_FAILED', 'Image request failed');
      finish(() => reject(error));
    });
    req.end();
  });
}

/**
 * Fetch a bounded raster image from a public host. Every redirect is parsed,
 * DNS-resolved, checked again, and connected using the checked address.
 */
export async function fetchPublicImage(
  input: string,
  options: SafeImageFetchOptions = {},
): Promise<FetchedImage> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const resolver = options.resolveHost ?? resolveHost;
  const makeRequest = options.requestOnce ?? requestOnce;
  const deadline = Date.now() + timeoutMs;
  let current = input;

  for (let redirects = 0; ; redirects++) {
    const parsed = validatePublicHttpUrl(current);
    if (!parsed.success) {
      throw new SafeImageError('INVALID_URL', `Unsafe image URL: ${parsed.message}`);
    }

    let addresses: ResolvedAddress[];
    try {
      addresses = await beforeDeadline(
        resolver(normalizeHostname(parsed.url.hostname)),
        deadline,
      );
    } catch (error) {
      if (error instanceof SafeImageError) throw error;
      throw new SafeImageError('DNS_FAILURE', 'Image host could not be resolved');
    }
    if (addresses.length === 0) {
      throw new SafeImageError('DNS_FAILURE', 'Image host has no usable address');
    }
    if (addresses.some(answer => !isPublicIpAddress(answer.address))) {
      throw new SafeImageError('NON_PUBLIC_ADDRESS', 'Image host resolved to a non-public address');
    }

    // Prefer IPv4 where both families are available because several serverless
    // environments advertise IPv6 without an outbound IPv6 route.
    const address = addresses.find(answer => answer.family === 4) ?? addresses[0];
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SafeImageError('UPSTREAM_TIMEOUT', 'Image request timed out');
    const response = await makeRequest(parsed.url, address, remaining, maxBytes);

    if (isRedirect(response.status)) {
      if (redirects >= maxRedirects) {
        throw new SafeImageError('TOO_MANY_REDIRECTS', 'Image redirected too many times');
      }
      const location = headerValue(response.headers, 'location');
      if (!location) {
        throw new SafeImageError('UPSTREAM_STATUS', 'Image redirect did not include a location');
      }
      try {
        current = new URL(location, parsed.url).toString();
      } catch {
        throw new SafeImageError('INVALID_URL', 'Image redirect URL is invalid');
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new SafeImageError('UPSTREAM_STATUS', `Image host returned HTTP ${response.status}`);
    }
    const contentType = normalizedContentType(response.headers);
    if (!ALLOWED_IMAGE_TYPES.has(contentType)) {
      throw new SafeImageError('UNSUPPORTED_TYPE', 'Upstream response is not a supported raster image');
    }
    if (response.body.byteLength === 0) {
      throw new SafeImageError('INVALID_IMAGE', 'Upstream image is empty');
    }
    if (response.body.byteLength > maxBytes) {
      throw new SafeImageError('TOO_LARGE', 'Upstream image is too large');
    }
    return { bytes: response.body, contentType, finalUrl: parsed.url.toString() };
  }
}

function decodeDataImage(value: string, maxBytes: number): Buffer {
  const match = /^data:(image\/(?:jpeg|png|gif|webp|avif));base64,([a-z0-9+/=]+)$/i.exec(value);
  if (!match || !ALLOWED_IMAGE_TYPES.has(match[1].toLowerCase())) {
    throw new SafeImageError('UNSUPPORTED_TYPE', 'Image data must be a supported base64 raster image');
  }
  const encoded = match[2];
  if (encoded.length > Math.ceil(maxBytes * 4 / 3) + 4 || encoded.length % 4 === 1) {
    throw new SafeImageError('TOO_LARGE', 'Embedded image is too large');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength === 0) throw new SafeImageError('INVALID_IMAGE', 'Embedded image is empty');
  if (bytes.byteLength > maxBytes) throw new SafeImageError('TOO_LARGE', 'Embedded image is too large');
  return bytes;
}

/** Load either a data URI or public remote image and return verified JPEG bytes. */
export async function loadImageAsJpeg(
  value: string,
  options: SafeImageFetchOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = value.startsWith('data:')
    ? decodeDataImage(value, maxBytes)
    : (await fetchPublicImage(value, options)).bytes;

  try {
    const sharp = getSharp();
    const jpeg = await sharp(raw, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
      sequentialRead: true,
    })
      .rotate()
      .resize({
        width: 4096,
        height: 4096,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer();
    if (jpeg.byteLength === 0 || jpeg.byteLength > MAX_OUTPUT_BYTES) {
      throw new SafeImageError('TOO_LARGE', 'Normalized image is too large');
    }
    return jpeg;
  } catch (error) {
    if (error instanceof SafeImageError) throw error;
    throw new SafeImageError('INVALID_IMAGE', 'Image bytes could not be decoded');
  }
}
