// @vitest-environment jsdom
/**
 * The controller binds window-level chords (⌥N notes, Cmd/Ctrl+F search,
 * Ctrl+Arrow transcript jumps) that would otherwise eat keys meant for the host
 * shell. The pane stops them on the way out — bubble phase, so ghostty still
 * sees the key first — which is invisible in the source and easy to undo by
 * "tidying" the listener into the capture phase. That inversion is what's tested.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { RemoteTerminalPane } from '../RemoteTerminalPane';

// The emulator is WASM; none of it is needed to exercise the listener, and
// loading it in jsdom would fail.
vi.mock('ghostty-web', () => ({
  Terminal: class {},
  FitAddon: class {},
}));
vi.mock('../../Terminal/ghosttyInstance', () => ({
  // Never resolves: the pane's init path is irrelevant here, and leaving it
  // pending keeps the test off the WASM/canvas path entirely.
  loadTerminalGhostty: () => new Promise(() => {}),
}));

describe('RemoteTerminalPane key routing', () => {
  beforeEach(() => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remoteSessions: { terminal: vi.fn(), onTerminalEvent: vi.fn(() => () => {}) },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('keeps keys inside the terminal from reaching the popover chords', () => {
    const bubble = vi.fn();
    const capture = vi.fn();
    window.addEventListener('keydown', bubble);
    window.addEventListener('keydown', capture, true);

    const { getByTestId, unmount } = render(<RemoteTerminalPane sessionId="s1" onClose={() => {}} />);

    // Stand in for ghostty's own input element, which lives inside the surface.
    // The key must be dispatched from a DESCENDANT, not the surface itself:
    // a capture-phase swallow is indistinguishable from a bubble-phase one at
    // the target, and capture is exactly the mistake this guards against.
    const emulatorInput = document.createElement('textarea');
    getByTestId('remote-terminal-surface').appendChild(emulatorInput);
    const emulator = vi.fn();
    emulatorInput.addEventListener('keydown', emulator);

    emulatorInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true }));

    // The emulator still gets the key — swallowing on the way in would break input.
    expect(emulator).toHaveBeenCalledTimes(1);
    // ⌥N never reaches the notes toggle…
    expect(bubble).not.toHaveBeenCalled();
    // …but the capture-phase listeners the controller relies on (auto-blur's
    // idle bump, the Ctrl+Shift chords) still run.
    expect(capture).toHaveBeenCalledTimes(1);

    window.removeEventListener('keydown', bubble);
    window.removeEventListener('keydown', capture, true);
    unmount();
  });
});
