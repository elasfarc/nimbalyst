// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildControllerTerminalTheme } from '../controllerTerminalTheme';

/** A reader can't see which ANSI set a given skin selects, so that's what's tested. */
const reader = (vars: Record<string, string>) => (name: string) => vars[name] ?? '';

describe('buildControllerTerminalTheme', () => {
  it('inverts the palette on a light skin so output stays readable', () => {
    // paper's background. "white" must become an ink, not stay #ffffff — a
    // program printing bright-white on near-white would otherwise vanish.
    const light = buildControllerTerminalTheme(reader({ '--nim-bg': '#faf8f3' }));
    const dark = buildControllerTerminalTheme(reader({ '--nim-bg': '#0a0d13' }));

    expect(light.brightWhite).toBe('#111827');
    expect(dark.brightWhite).toBe('#ffffff');
    expect(light.black).not.toBe('#000000');
  });

  it('falls back to the dark set when the background is not a parseable hex', () => {
    const theme = buildControllerTerminalTheme(reader({ '--nim-bg': 'color-mix(in srgb, white, black)' }));
    expect(theme.brightWhite).toBe('#ffffff');
  });

  it('takes the surface colours from the skin and defaults the rest', () => {
    const theme = buildControllerTerminalTheme(
      reader({ '--nim-bg': '#000', '--nim-text': '#35ff6a', '--nim-primary': '#9dff4d' }),
    );
    expect(theme.background).toBe('#000');
    expect(theme.foreground).toBe('#35ff6a');
    expect(theme.cursor).toBe('#9dff4d');
    // Unset vars fall through rather than resolving to ''.
    expect(theme.selectionBackground).toBeTruthy();
  });
});
