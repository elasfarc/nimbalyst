/**
 * RemoteTerminalPane — a shell running on the HOST, typed into from here.
 *
 * The host spawns a real PTY in the session's working directory and relays its
 * bytes over the session-control channel. Those bytes are fed to a real terminal
 * emulator — the same `ghostty-web` the desktop's own terminal uses — so colour,
 * cursor addressing and full-screen programs (vim, htop, a pager, the CLI's own
 * TUI) render the way they do in a local terminal. Keystrokes go back the same
 * way, unbuffered, so tab completion, Ctrl+R, Ctrl+C and readline editing are the
 * shell's to handle rather than something reimplemented here.
 *
 * The cost of that fidelity is a round trip per keystroke: the pane echoes
 * nothing locally, because only the host knows whether the shell is echoing at
 * all (it must not echo a `sudo` password). On a slow relay typing feels remote,
 * which is the honest representation of what it is.
 *
 * The pane owns the terminal's lifetime: it opens one on mount and closes it on
 * unmount, so nothing is left running on the host after you close it.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Terminal, FitAddon } from 'ghostty-web';
import { loadTerminalGhostty } from '../Terminal/ghosttyInstance';
import { waitUntilElementMeasurable } from '../Terminal/terminalVisibility';
import { readControllerTerminalTheme } from './controllerTerminalTheme';

/** Smallest useful pane; below this the prompt and a line of output don't fit. */
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 280;
const HEIGHT_STORAGE_KEY = 'controller.remoteTerminal.height';

/**
 * Scrollback is far shorter than the desktop terminal's 50k: this pane is
 * ephemeral by construction (it dies with the mount), and every line in it
 * crossed a relay, so retaining a session's worth of it buys nothing.
 */
const SCROLLBACK_LINES = 5_000;

/** A terminal must be monospace, whatever font the controller skin is wearing. */
const TERMINAL_FONT =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Code", "Roboto Mono", monospace';

/**
 * A resize burst (a height drag, the column changing width) would send one
 * SIGWINCH per frame, and a TUI reflows fully on each — over a relay that is
 * both a flood and a source of half-drawn frames. Collapse the burst.
 */
const RESIZE_DEBOUNCE_MS = 120;

interface RemoteTerminalPaneProps {
  sessionId: string;
  onClose: () => void;
}

/** Stable per-mount id so the host can tell two open panes apart. */
function newTerminalId(): string {
  return `ctl-${Math.random().toString(36).slice(2, 10)}`;
}

export function RemoteTerminalPane({ sessionId, onClose }: RemoteTerminalPaneProps) {
  const terminalIdRef = useRef<string>(newTerminalId());
  const [status, setStatus] = useState<'opening' | 'ready' | 'closed'>('opening');
  const [error, setError] = useState<string | null>(null);
  const [cwd, setCwd] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  // Drag-resizable pane height, remembered across mounts.
  const [height, setHeight] = useState<number>(() => {
    const saved = Number(localStorage.getItem(HEIGHT_STORAGE_KEY));
    return Number.isFinite(saved) && saved >= MIN_HEIGHT ? saved : DEFAULT_HEIGHT;
  });
  const heightRef = useRef(height);
  heightRef.current = height;

  const send = useCallback(
    (
      type: 'terminal_open' | 'terminal_input' | 'terminal_resize' | 'terminal_close',
      extra: Record<string, unknown> = {},
    ) => {
      void window.electronAPI?.remoteSessions?.terminal?.({
        sessionId,
        type,
        terminalId: terminalIdRef.current,
        ...extra,
      });
    },
    [sessionId],
  );

  useEffect(() => {
    const terminalId = terminalIdRef.current;
    let disposed = false;
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    // Output can arrive before the WASM emulator has finished loading, because
    // the shell is spawned in parallel with it (below). Hold those bytes and
    // replay them in order once there is something to write them to.
    let pending: string[] | null = [];
    const write = (data: string) => {
      if (pending) pending.push(data);
      else terminalRef.current?.write(data);
    };

    const off = window.electronAPI?.remoteSessions?.onTerminalEvent?.((event) => {
      if (event.sessionId !== sessionId || event.payload?.terminalId !== terminalId) return;
      if (event.type === 'terminal_output') {
        write(String(event.payload.data ?? ''));
      } else if (event.type === 'terminal_ready') {
        setStatus('ready');
        setCwd(typeof event.payload.cwd === 'string' ? event.payload.cwd : null);
      } else if (event.type === 'terminal_exit') {
        setStatus('closed');
        // Written as dim text rather than shown in the header: it belongs after
        // the last line of output, where the reader is already looking.
        write('\r\n\x1b[2m[the host shell exited]\x1b[0m\r\n');
      } else if (event.type === 'terminal_error') {
        setError(String(event.payload.error ?? 'The host refused the terminal'));
        setStatus('closed');
      }
    });

    // Spawn the shell now rather than after the emulator is up: the relay round
    // trip dwarfs the WASM decode, so asking first means the prompt is usually
    // already in flight by the time there is a screen to paint it on. The size
    // is provisional — `fit()` sends the real one below, and the shell repaints
    // on the resulting SIGWINCH.
    send('terminal_open', { cols: 80, rows: 24 });

    void (async () => {
      const ghostty = await loadTerminalGhostty();
      if (disposed || !hostRef.current) return;
      // The pane can mount while the transcript column is still laying out; a
      // terminal built against a zero-size element renders nothing.
      if ((await waitUntilElementMeasurable(hostRef.current, { isDisposed: () => disposed })) !== 'measurable') {
        return;
      }
      if (!hostRef.current) return;

      terminal = new Terminal({
        ghostty,
        fontSize: 12,
        fontFamily: TERMINAL_FONT,
        scrollback: SCROLLBACK_LINES,
        cursorBlink: false,
        cursorStyle: 'bar',
        theme: readControllerTerminalTheme(),
      });
      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(hostRef.current);
      // Let the canvas take its size before measuring it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (disposed) return;

      terminalRef.current = terminal;
      const buffered = pending ?? [];
      pending = null;
      for (const chunk of buffered) terminal.write(chunk);

      inputDisposable = terminal.onData((data) => {
        if (!disposed) send('terminal_input', { data });
      });

      const applyResize = () => {
        if (!fitAddon || disposed) return;
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims && dims.cols > 0 && dims.rows > 0) {
            send('terminal_resize', { cols: dims.cols, rows: dims.rows });
          }
        } catch {
          /* a fit against a disposed or unmeasurable canvas is not worth reporting */
        }
      };
      applyResize();

      // Covers both the height drag and the column changing width, so neither
      // needs its own effect.
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          if (disposed) return;
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            applyResize();
          }, RESIZE_DEBOUNCE_MS);
        });
        resizeObserver.observe(hostRef.current);
      }

      terminal.focus();
    })();

    return () => {
      disposed = true;
      send('terminal_close');
      if (typeof off === 'function') off();
      resizeObserver?.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      inputDisposable?.dispose();
      terminal?.dispose();
      fitAddon?.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, send]);

  // Keystrokes that reached the terminal belong to the shell, not to the
  // popover. The controller binds several window-level chords — ⌥N for notes,
  // Cmd/Ctrl+F for session search, Ctrl+Arrow/Home/End to jump the transcript —
  // and several of those guard only against INPUT/TEXTAREA targets or nothing at
  // all, so Alt-meta sequences and readline's own Ctrl+F would be swallowed
  // before the PTY ever saw them.
  //
  // Stopped on the way OUT (bubble phase, on the terminal's own container) so
  // ghostty still handles the event first: stopping it on the way in would take
  // the key away from the emulator too. The controller's deliberate Ctrl+Shift
  // chords and the auto-blur idle bump listen in the capture phase and are
  // untouched by design — they should keep working while the terminal is focused.
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const swallow = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener('keydown', swallow);
    return () => el.removeEventListener('keydown', swallow);
  }, []);

  // The skin can change while the pane is open (the appearance menu writes the
  // `--nim-*` palette straight onto documentElement), and the emulator holds a
  // snapshot of those colours rather than the vars themselves.
  useEffect(() => {
    if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    const observer = new MutationObserver(() => {
      if (terminalRef.current) terminalRef.current.options.theme = readControllerTerminalTheme();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
    return () => observer.disconnect();
  }, []);

  const onResizeStart = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = heightRef.current;
    const onMove = (ev: PointerEvent) => {
      // Drag up grows the pane; clamp so it can't swallow the whole window.
      const next = Math.max(MIN_HEIGHT, Math.min(window.innerHeight - 100, startHeight + (startY - ev.clientY)));
      heightRef.current = next;
      setHeight(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      localStorage.setItem(HEIGHT_STORAGE_KEY, String(Math.round(heightRef.current)));
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className="remote-terminal-pane flex flex-col min-h-0 border-t"
      style={{ borderColor: 'var(--nim-border)', background: 'var(--nim-bg)', height: `${height}px` }}
      data-testid="remote-terminal-pane"
    >
      <div
        className="remote-terminal-resize-handle h-1 shrink-0 cursor-row-resize"
        style={{ marginTop: '-1px', background: 'transparent' }}
        onPointerDown={onResizeStart}
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the terminal"
        title="Drag to resize the terminal"
        data-testid="remote-terminal-resize"
      />
      <div
        className="remote-terminal-header flex items-center justify-between px-2 h-6 shrink-0 text-[10px]"
        style={{ color: 'var(--nim-text-muted)' }}
      >
        <span className="truncate" title={cwd ?? undefined}>
          {error ? error : status === 'opening' ? 'starting a shell on the host…' : cwd ?? 'host shell'}
        </span>
        <button
          className="remote-terminal-close px-1"
          style={{ color: 'var(--nim-text-muted)' }}
          onClick={onClose}
          title="Close the terminal"
          aria-label="Close the terminal"
          data-testid="remote-terminal-close"
        >
          ×
        </button>
      </div>

      <div
        ref={hostRef}
        className="remote-terminal-surface flex-1 min-h-0 px-2 pb-1"
        onClick={() => terminalRef.current?.focus()}
        data-testid="remote-terminal-surface"
      />
    </div>
  );
}
