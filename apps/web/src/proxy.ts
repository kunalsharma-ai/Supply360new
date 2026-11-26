import { NextResponse, type NextRequest } from 'next/server';

/**
 * Content-Security-Policy with a fresh nonce per request. Next reads the nonce from the request's CSP header and
 * puts it on its own scripts, so no inline script runs without it. The API is same-origin through the rewrite, so
 * connect-src stays 'self'. HSTS and upgrade-insecure-requests are only sent when the request came over https.
 */
export function proxy(req: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const dev = process.env.NODE_ENV !== 'production';
  // Behind the TLS-terminating proxy the request arrives as http with x-forwarded-proto=https.
  const https = req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${dev ? ' ws:' : ''}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(https ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', csp);
  if (https) res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  return res;
}

export const config = {
  // Static assets and the API rewrite don't need a page policy.
  matcher: [{ source: '/((?!api/|_next/static|_next/image|favicon.ico).*)', missing: [{ type: 'header', key: 'next-router-prefetch' }] }],
};
