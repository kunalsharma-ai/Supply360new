import { describe, expect, it } from 'vitest';
import { MODULES } from './modules.js';

describe('module registry', () => {
  it('lists all 35 modules once, numbered 1 to 35', () => {
    expect(MODULES.map((m) => m.n).sort((a, b) => a - b)).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(new Set(MODULES.map((m) => m.href)).size).toBe(35);
  });
});
