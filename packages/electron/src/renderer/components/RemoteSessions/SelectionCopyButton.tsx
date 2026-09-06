/**
 * A small "Copy" chip that appears over a text selection anywhere in the
 * transcript and copies it on click — so you never have to reach for Cmd+C.
 *
 * Skin-agnostic: it watches selections inside the passed container ref, so it
 * works the same in the chat, TextSoap, and Buffer views. The selected text is
 * whatever is on screen — already Markdown-stripped by the projection — so a
 * copy lands as clean plain text. Positioned with @floating-ui against a virtual
 * anchor at the selection rect (never manual fixed coordinates).
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useFloating, offset, flip, shift, FloatingPortal } from '@floating-ui/react';

interface SelectionCopyButtonProps {
  containerRef: RefObject<HTMLElement | null>;
}

export function SelectionCopyButton({ containerRef }: SelectionCopyButtonProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  // Read the current selection; keep the chip only when there is a non-empty
  // selection that lives inside our container.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const refresh = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setRect(null);
        return;
      }
      const value = sel.toString().trim();
      const range = sel.getRangeAt(0);
      if (!value || !container.contains(range.commonAncestorContainer)) {
        setRect(null);
        return;
      }
      setText(value);
      setRect(range.getBoundingClientRect());
    };
    // mouseup / keyup catch the end of a drag- or shift-select; selectionchange
    // catches a click that clears the selection so the chip goes away.
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setRect(null);
    };
    const onScroll = () => setRect(null);
    document.addEventListener('mouseup', refresh);
    document.addEventListener('keyup', refresh);
    document.addEventListener('selectionchange', onSelectionChange);
    container.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mouseup', refresh);
      document.removeEventListener('keyup', refresh);
      document.removeEventListener('selectionchange', onSelectionChange);
      container.removeEventListener('scroll', onScroll, true);
    };
  }, [containerRef]);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

  const { refs, floatingStyles } = useFloating({
    open: !!rect,
    placement: 'top',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
  });

  // Virtual anchor pinned to the current selection rect.
  useEffect(() => {
    if (rect) refs.setReference({ getBoundingClientRect: () => rect });
  }, [rect, refs]);

  if (!rect) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => {
        setCopied(false);
        setRect(null);
      }, 900);
    } catch {
      /* clipboard blocked — leave the chip so the user can try Cmd+C */
    }
  };

  return (
    <FloatingPortal>
      <button
        ref={refs.setFloating}
        className="remote-session-copy-selection text-[11px] px-2 py-0.5 rounded shadow"
        style={{
          ...floatingStyles,
          background: 'var(--nim-bg-secondary)',
          color: copied ? 'var(--nim-success)' : 'var(--nim-primary)',
          border: '1px solid var(--nim-border)',
          zIndex: 60,
        }}
        // Keep the selection alive through the click so the copy has something to grab.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void copy()}
        data-testid="remote-session-copy-selection"
        title="Copy the selected text"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </FloatingPortal>
  );
}
