import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// WCAG 2.2 relative luminance and contrast ratio.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const blocks = [...css.matchAll(/\[data-theme='(\w+)'\]\s*\{([^}]+)\}/g)].map(([, name, body]) => {
  const v = Object.fromEntries([...body!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map(([, k, val]) => [k!, val!]));
  return { name: name!, v };
});

describe('theme tokens', () => {
  it('defines all four themes', () =>
    expect(blocks.map((b) => b.name).sort()).toEqual(['arctic', 'emerald', 'midnight', 'violet']));
  for (const { name, v } of blocks) {
    it(`${name}: body and muted text meet AA on every surface`, () => {
      for (const s of ['bg', 'surface', 'surface-2']) {
        expect(ratio(v.text!, v[s]!)).toBeGreaterThanOrEqual(4.5);
        expect(ratio(v['text-muted']!, v[s]!)).toBeGreaterThanOrEqual(4.5);
      }
    });
    it(`${name}: accent buttons are readable`, () =>
      expect(ratio(v['accent-contrast']!, v.accent!)).toBeGreaterThanOrEqual(4.5));
  }
});
