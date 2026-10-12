import type { NextConfig } from 'next';

import { join } from 'node:path';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@naijaproperty/ui', '@naijaproperty/contracts'],
  // This monorepo root is needed because the workspace root holds
  // package-lock.json and Next otherwise infers a higher directory as root,
  // which breaks tracing of the shared packages.
  outputFileTracingRoot: join(import.meta.dirname, '..', '..'),

  /*
   * Emit a self-contained server bundle under .next/standalone.
   *
   * Required by apps/web/Dockerfile, and the reason that image does not ship
   * node_modules at all. Next traces exactly the files this app reaches at
   * runtime, including the workspace packages, so the runtime stage copies a
   * folder that already contains the right dependencies.
   *
   * Additive: `next build` and `next start` behave the same as before, so local
   * development and the existing npm scripts are unaffected.
   */
  output: 'standalone',

  images: {
    // R2 public URL and Cloudflare Stream thumbnails.
    remotePatterns: [
      { protocol: 'https', hostname: '**.r2.dev' },
      { protocol: 'https', hostname: 'pub-*.r2.dev' },
      { protocol: 'https', hostname: 'customer-*.cloudflarestream.com' },
      { protocol: 'https', hostname: '**.cloudflarestream.com' },
    ],
    formats: ['image/avif', 'image/webp'],
    // Small in-memory cache; the R2/Cloudflare CDN does the heavy lifting.
    minimumCacheTTL: 60 * 60 * 24,
  },

  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self)' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
