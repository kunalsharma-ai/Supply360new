import { createHmac, timingSafeEqual } from 'node:crypto';

export const WINDOW_SECONDS = 300;

export type VerifyResult = { ok: true; signedAt: Date } | { ok: false; reason: string };

/**
 * SampTrek webhook signature: `sha256=` + HMAC-SHA256 of `{timestamp}.{raw body}` (docs/PUBLIC_API.md), inside a
 * ±5 minute window. The raw bytes are verified, never a re-serialized body.
 */
export function verifySampTrek(
  secret: string,
  headers: { timestamp?: string; signature?: string },
  rawBody: Buffer,
  nowMs = Date.now(),
): VerifyResult {
  const ts = headers.timestamp ?? '';
  if (!/^\d{9,11}$/.test(ts)) return { ok: false, reason: 'missing or malformed timestamp' };
  if (Math.abs(nowMs / 1000 - Number(ts)) > WINDOW_SECONDS) return { ok: false, reason: 'timestamp outside window' };
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex')}`);
  const got = Buffer.from(headers.signature ?? '');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'bad signature' };
  return { ok: true, signedAt: new Date(Number(ts) * 1000) };
}

/** Used by tests and the FIXTURE webhook sender to produce SampTrek-identical deliveries. */
export function signSampTrek(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  return { 'x-projexa-timestamp': String(ts), 'x-projexa-signature': sig };
}
