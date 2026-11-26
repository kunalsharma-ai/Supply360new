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

describe('key rotation', () => {
  const oldKey = randomBytes(32).toString('base64');
  const newKey = randomBytes(32).toString('base64');
  it('opens values sealed with the previous key and seals with the new one', () => {
    const sealed = new Sealer(oldKey).seal('whsec_x', 'ctx');
    const rotating = new Sealer(newKey, oldKey);
    expect(rotating.openWithKey(sealed, 'ctx')).toEqual({ plain: 'whsec_x', keyIndex: 1 });
    const resealed = rotating.seal('whsec_x', 'ctx');
    expect(rotating.openWithKey(resealed, 'ctx').keyIndex).toBe(0);
    expect(new Sealer(newKey).open(resealed, 'ctx')).toBe('whsec_x');
  });
  it('still refuses a wrong context or an unknown key', () => {
    const sealed = new Sealer(oldKey).seal('s', 'ctx');
    expect(() => new Sealer(newKey, oldKey).open(sealed, 'other')).toThrow();
    expect(() => new Sealer(newKey).open(sealed, 'ctx')).toThrow();
  });
});
