import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const toKey = (base64Key: string) => {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('Sealer key must be 32 bytes');
  return key;
};

/**
 * AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext>, base64url. Seals with the current key; opens with the current key
 * and then the previous one, so FIELD_ENCRYPTION_KEY can be rotated without downtime (see the key rotation runbook,
 * then `pnpm --filter @s360/api rotate:reseal` moves every sealed value onto the new key).
 */
export class Sealer {
  private readonly key: Buffer;
  private readonly keys: Buffer[];
  constructor(base64Key: string, previousBase64Key?: string) {
    this.key = toKey(base64Key);
    this.keys = previousBase64Key ? [this.key, toKey(previousBase64Key)] : [this.key];
  }
  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(context));
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv, c.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }
  open(sealed: string, context: string): string {
    return this.openWithKey(sealed, context).plain;
  }
  /** Which key opened it: 0 is current, 1 is previous. The re-seal script uses this to skip values already moved. */
  openWithKey(sealed: string, context: string): { plain: string; keyIndex: number } {
    const [v, iv, tag, body] = sealed.split('.');
    if (v !== 'v1' || !iv || !tag || !body) throw new Error('Unknown sealed format');
    let last: unknown;
    for (const [keyIndex, key] of this.keys.entries()) {
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAAD(Buffer.from(context));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return { plain: Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8'), keyIndex };
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }
}

/** The API's sealer: current key, plus the previous one while a rotation is in progress. */
export const sealerFor = (env: { FIELD_ENCRYPTION_KEY: string; FIELD_ENCRYPTION_KEY_PREVIOUS?: string | undefined }) =>
  new Sealer(env.FIELD_ENCRYPTION_KEY, env.FIELD_ENCRYPTION_KEY_PREVIOUS);
