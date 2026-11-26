import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Participation tokens: 22 characters of the invitation id and 22 of an HMAC over it, base64url, 44 in all.
 * Opaque (no name, panel or project in it), unforgeable without the key, regenerable for reminders, and safe in
 * SampTrek's [UID] slot (letters, digits, - and _ only). Nothing about the token is stored.
 */
export class TokenSigner {
  private readonly key: Buffer;
  constructor(secret: string) {
    this.key = createHash('sha256').update(`s360-participation-token:${secret}`).digest();
  }
  private mac(id: Buffer) {
    return createHmac('sha256', this.key).update(id).digest().subarray(0, 16);
  }
  sign(invitationId: string): string {
    const id = Buffer.from(invitationId.replaceAll('-', ''), 'hex');
    return id.toString('base64url') + this.mac(id).toString('base64url');
  }
  /** The invitation id, or null for anything that is not a token this key signed. */
  verify(token: string): string | null {
    if (!/^[A-Za-z0-9_-]{44}$/.test(token)) return null;
    const id = Buffer.from(token.slice(0, 22), 'base64url');
    const mac = Buffer.from(token.slice(22), 'base64url');
    if (id.length !== 16 || mac.length !== 16 || !timingSafeEqual(mac, this.mac(id))) return null;
    const h = id.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}
