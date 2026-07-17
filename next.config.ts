import type { NextConfig } from "next";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://ai-microgrant-research-oberlin.vercel.app';
const FIREBASE_AUTH_DOMAIN = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || 'ai-microgrant-research.firebaseapp.com';

if (!/^[a-z0-9-]+\.(?:firebaseapp\.com|web\.app)$/.test(FIREBASE_AUTH_DOMAIN)) {
  throw new Error('NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN must be a Firebase Hosting domain.');
}

const securityHeaders = [
  { key: 'X-DNS-Prefetch-Control',  value: 'on' },
  { key: 'X-Frame-Options',         value: 'SAMEORIGIN' },
  { key: 'X-Content-Type-Options',  value: 'nosniff' },
  { key: 'Referrer-Policy',         value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy',      value: 'camera=(), microphone=(), geolocation=()' },
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  compress: true,
  reactStrictMode: true,
  // node_modules is symlinked to node_modules.nosync in local workspaces.
  // Make the native sharp addon explicitly external so webpack does not try
  // to bundle platform-specific optional binaries from the symlink target.
  serverExternalPackages: ['sharp'],
  outputFileTracingExcludes: {
    '/*': ['.claude/**/*', 'coverage/**/*', 'scripts/**/*'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
  },
  async rewrites() {
    // Firebase redirect auth must use same-origin helper pages on browsers
    // that partition third-party storage. Keep these as transparent rewrites;
    // a 302 redirect would put the helper back on a cross-origin domain.
    return [
      {
        source: '/__/auth/:path*',
        destination: `https://${FIREBASE_AUTH_DOMAIN}/__/auth/:path*`,
      },
      {
        source: '/__/firebase/:path*',
        destination: `https://${FIREBASE_AUTH_DOMAIN}/__/firebase/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: securityHeaders,
      },
      {
        source: '/api/events(.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin',  value: APP_URL },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Vary', value: 'Origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
