import { Secret, TOTP } from 'otpauth';

const PERIOD = 30;

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function otpauthUri(secret: string, label: string, issuer = 'Supply360'): string {
  return new TOTP({
    issuer,
    label,
    secret: Secret.fromBase32(secret),
    period: PERIOD,
    digits: 6,
    algorithm: 'SHA1',
  }).toString();
}

/** Returns the matched time step, or null. One step of drift each way. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const totp = new TOTP({ secret: Secret.fromBase32(secret), period: PERIOD, digits: 6, algorithm: 'SHA1' });
  const delta = totp.validate({ token: code, window: 1, timestamp: now });
  if (delta === null) return null;
  return Math.floor(now / 1000 / PERIOD) + delta;
}
