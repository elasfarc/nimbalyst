/**
 * Copy-on-select for the transcript: the instant you finish selecting text
 * anywhere in the transcript, it is copied to the clipboard and a brief "Copied"
 * confirmation floats over the selection. No button to reach for — reaching for
 * one loses the selection before the click lands (the bug this replaces).
 *
 * Skin-agnostic: watches selections inside the passed container ref, so it works
 * the same in the chat, TextSoap, and Buffer views. The copied text is whatever
 * is on screen — already Markdown-stripped by the projection — so it lands as
 * clean plain text. The toast is positioned with @floating-ui against a virtual
 * anchor at the selection rect (never manual fixed coordinates).
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal } from '@floating-ui/react';

interface SelectionCopyButtonProps {
  containerRef: RefObject<HTMLElement | null>;
}

export function SelectionCopyButton({ containerRef }: SelectionCopyButtonProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // mouseup ends a drag- or shift-select. It is a user gesture, so writing to
    // the clipboard here is allowed — and copying now (rather than on a later
    // click) means the selection can't vanish out from under us.
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const value = sel.toString().trim();
      const range = sel.getRangeAt(0);
      if (!value || !container.contains(range.commonAncestorContainer)) return;
      const anchor = range.getBoundingClientRect();
      void navigator.clipboard
        .writeText(value)
        .then(() => {
          setRect(anchor);
          if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
          hideTimer.current = window.setTimeout(() => setRect(null), 1100);
        })
        .catch(() => {
          /* clipboard blocked — nothing to confirm, the user can still Cmd+C */
        });
    };
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mouseup', onUp);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    };
  }, [containerRef]);

  const { refs, floatingStyles } = useFloating({
    open: !!rect,
    placement: 'top',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // Virtual anchor pinned to the selection rect.
  useEffect(() => {
    if (rect) refs.setReference({ getBoundingClientRect: () => rect });
  }, [rect, refs]);

  if (!rect) return null;

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        className="remote-session-copy-selection text-[11px] px-2 py-0.5 rounded shadow pointer-events-none"
        style={{
          ...floatingStyles,
          background: 'var(--nim-bg-secondary)',
          color: 'var(--nim-success)',
          border: '1px solid var(--nim-border)',
          zIndex: 60,
        }}
        data-testid="remote-session-copy-selection"
      >
        Copied
      </div>
    </FloatingPortal>
  );
}
