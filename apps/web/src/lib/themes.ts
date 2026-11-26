export const THEMES = [
  {
    id: 'adventure',
    name: 'Adventure Park',
    hint: 'Bright, playful and colourful, with 3D motion',
    swatch: ['#fff3d6', '#c026d3'],
  },
  {
    id: 'glass',
    name: 'Glass',
    hint: 'Frosted glass over a deep gradient',
    swatch: ['#141a36', '#7dd3fc'],
  },
  {
    id: 'midnight',
    name: 'Midnight Command',
    hint: 'Navy and cyan, for control rooms',
    swatch: ['#0c1527', '#22d3ee'],
  },
  {
    id: 'arctic',
    name: 'Arctic Professional',
    hint: 'Light and crisp, for long sessions',
    swatch: ['#ffffff', '#1a52bd'],
  },
  { id: 'violet', name: 'Neural Violet', hint: 'Deep violet, for AI work', swatch: ['#140c24', '#a78bfa'] },
  { id: 'emerald', name: 'Emerald Intelligence', hint: 'Teal on green-black', swatch: ['#071c17', '#2dd4bf'] },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];
export const THEME_KEY = 's360-theme';
export const DEFAULT_THEME: ThemeId = 'adventure';
export const LIGHT_THEMES: readonly ThemeId[] = ['arctic', 'adventure'];
export const isLight = (t: ThemeId) => LIGHT_THEMES.includes(t);
export const MOTION_KEY = 's360-motion';
export function isTheme(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v);
}
