import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * MADP service request signing, byte for byte as MADP verifies it (madp apps/api/src/supply360/signature.ts):
 * `v1=<hex HMAC-SHA256(secret, "<ts>.<nonce>.<METHOD>.<path>.<sha256 hex of raw body>")>`, where path is the
 * request path without its query string. MADP accepts a nonce once and a timestamp within 300 seconds.
 */
export const bodyHash = (raw: string) => createHash('sha256').update(raw).digest('hex');

export function signMadp(secret: string, ts: string, nonce: string, method: string, path: string, rawBody: string) {
  const mac = createHmac('sha256', secret)
    .update(`${ts}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash(rawBody)}`)
    .digest('hex');
  return `v1=${mac}`;
}

export function madpHeaders(
  o: { clientId: string; secret: string; method: string; path: string; body: string },
  nowMs = Date.now(),
): Record<string, string> {
  const ts = String(Math.floor(nowMs / 1000));
  const nonce = randomBytes(18).toString('base64url');
  return {
    'x-madp-client': o.clientId,
    'x-madp-timestamp': ts,
    'x-madp-nonce': nonce,
    'x-madp-signature': signMadp(o.secret, ts, nonce, o.method, o.path, o.body),
  };
}
