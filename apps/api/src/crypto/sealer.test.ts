import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sealer } from './sealer.js';

describe('Sealer', () => {
  const s = new Sealer(randomBytes(32).toString('base64'));
  it('round-trips', () => expect(s.open(s.seal('secret', 'user:1'), 'user:1')).toBe('secret'));
  it('refuses another context', () => expect(() => s.open(s.seal('secret', 'user:1'), 'user:2')).toThrow());
  it('refuses tampering', () => {
    const sealed = s.seal('secret', 'c');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => s.open(parts.join('.'), 'c')).toThrow();
  });
});
