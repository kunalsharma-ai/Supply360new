import type { NextConfig } from 'next';

const api = process.env.S360_API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // Same-origin API: the session cookie is SameSite=Strict and httpOnly.
  async rewrites() {
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
