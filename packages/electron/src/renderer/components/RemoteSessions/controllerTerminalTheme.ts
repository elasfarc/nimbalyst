/**
 * Palette for the controller's host shell.
 *
 * The desktop terminal reads `--terminal-*` CSS vars, but the controller popover
 * doesn't define those — it is skinned by `controllerAppearance.ts`, which writes
 * a `--nim-*` palette onto documentElement and can be light (paper, chalk, sepia)
 * or dark. So the surface colours come from `--nim-*`, and the ANSI 16 come from
 * one of two fixed sets picked by the luminance of the resolved background.
 *
 * The light set is not "the dark set, lighter": on a near-white background the
 * bright colours are invisible, so it inverts the way Solarized Light does —
 * `white`/`brightWhite` are the darkest inks, because a program printing "white"
 * means "my most prominent colour", not a literal hue.
 */
import type { ITheme } from 'ghostty-web';

/** ANSI 16 for a dark background — the desktop terminal's own fallbacks. */
const DARK_ANSI = {
  black: '#000000',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#ffffff',
  brightBlack: '#6b7280',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#ffffff',
} as const;

/** ANSI 16 for a light background: saturated mid-darks, inverted black/white. */
const LIGHT_ANSI = {
  black: '#1f2937',
  red: '#b91c1c',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#7e22ce',
  cyan: '#0e7490',
  white: '#4b5563',
  brightBlack: '#9ca3af',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#9333ea',
  brightCyan: '#0891b2',
  brightWhite: '#111827',
} as const;

/**
 * Relative luminance of a `#rgb` / `#rrggbb` colour, or null if it isn't one.
 * The controller palettes are all hex literals, so no general colour parser is
 * warranted — anything else falls back to the dark set, which is the default skin.
 */
export function hexLuminance(color: string): number | null {
  const hex = color.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = (offset: number) => {
    const v = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Build the emulator theme from a CSS-variable reader.
 *
 * `read` takes a var name and returns its value ('' when unset), so this stays a
 * pure function the tests can drive without a DOM.
 */
export function buildControllerTerminalTheme(read: (name: string) => string): ITheme {
  const value = (name: string, fallback: string): string => read(name).trim() || fallback;

  const background = value('--nim-bg', '#0a0d13');
  const luminance = hexLuminance(background);
  const ansi = luminance !== null && luminance > 0.5 ? LIGHT_ANSI : DARK_ANSI;

  return {
    background,
    foreground: value('--nim-text', ansi.brightWhite),
    // The caret is the one place the skin's accent belongs: it is chrome, not
    // program output, so tinting it keeps the pane in the popover's family.
    cursor: value('--nim-primary', ansi.brightBlue),
    cursorAccent: background,
    selectionBackground: value('--nim-bg-selected', 'rgba(125, 125, 125, 0.35)'),
    ...ansi,
  };
}

/** Read the theme off documentElement's resolved `--nim-*` vars. */
export function readControllerTerminalTheme(): ITheme {
  if (typeof document === 'undefined') return buildControllerTerminalTheme(() => '');
  const style = getComputedStyle(document.documentElement);
  return buildControllerTerminalTheme((name) => style.getPropertyValue(name));
}
