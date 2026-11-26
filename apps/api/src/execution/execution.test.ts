import { describe, expect, it } from 'vitest';
import { inQuietHours, isScanner, localParts, quietEndsAt } from './policy.js';
import { TokenSigner } from './token.js';

describe('participation tokens', () => {
  const s = new TokenSigner('x'.repeat(40));
  const id = '0193a3c4-5b6d-7e8f-9a0b-1c2d3e4f5a6b';
  it('round-trips, is 44 URL-safe characters, and is the same every time (reminders reuse it)', () => {
    const t = s.sign(id);
    expect(t).toMatch(/^[A-Za-z0-9_-]{44}$/);
    expect(s.sign(id)).toBe(t);
    expect(s.verify(t)).toBe(id);
  });
  it('refuses a changed character, another key, and junk', () => {
    const t = s.sign(id);
    for (let i = 0; i < 44; i += 7) {
      const c = t[i] === 'A' ? 'B' : 'A';
      expect(s.verify(t.slice(0, i) + c + t.slice(i + 1))).toBeNull();
    }
    expect(new TokenSigner('y'.repeat(40)).verify(t)).toBeNull();
    for (const x of ['', 'abc', 'x'.repeat(44), `${t}=`, t.replace(/.$/, '+')]) expect(s.verify(x)).toBeNull();
  });
  it('carries no readable identifier', () => expect(s.sign(id)).not.toContain(id.slice(0, 8)));
});

describe('quiet hours and days', () => {
  const at = (iso: string) => new Date(iso);
  it('handles a window that wraps past midnight, in the policy time zone', () => {
    const p = { timezone: 'Asia/Kolkata', quietStartHour: 21, quietEndHour: 8 };
    expect(inQuietHours(p, at('2026-11-26T16:00:00Z'))).toBe(true); // 21:30 IST
    expect(inQuietHours(p, at('2026-11-26T02:00:00Z'))).toBe(true); // 07:30 IST
    expect(inQuietHours(p, at('2026-11-26T03:00:00Z'))).toBe(false); // 08:30 IST
    expect(inQuietHours(p, at('2026-11-26T10:00:00Z'))).toBe(false); // 15:30 IST
  });
  it('treats equal hours as no quiet hours', () =>
    expect(inQuietHours({ timezone: 'UTC', quietStartHour: 5, quietEndHour: 5 }, at('2026-11-26T05:30:00Z'))).toBe(false));
  it('finds local midnight for the daily maximum', () => {
    expect(localParts('America/New_York', at('2026-11-26T03:00:00Z')).midnight.toISOString()).toBe('2026-11-25T05:00:00.000Z');
    expect(localParts('UTC', at('2026-11-26T03:00:00Z')).midnight.toISOString()).toBe('2026-11-26T00:00:00.000Z');
  });
  it('says when quiet hours end', () =>
    expect(quietEndsAt({ timezone: 'UTC', quietStartHour: 21, quietEndHour: 8 }, at('2026-11-26T22:00:00Z')).toISOString()).toBe(
      '2026-11-27T08:00:00.000Z',
    ));
});

describe('link scanners', () => {
  it('HEAD, a missing user agent and known scanners are not people', () => {
    expect(isScanner('HEAD', 'Mozilla/5.0')).toBe(true);
    expect(isScanner('GET', undefined)).toBe(true);
    expect(isScanner('GET', 'Mozilla/5.0 (compatible; Mimecast)')).toBe(true);
    expect(isScanner('GET', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/605.1.15')).toBe(false);
  });
});
