import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  /** Read out as the dialog's name; also its visible heading unless `hideTitle`. */
  title: string;
  hideTitle?: boolean;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * A modal over the Grab-it window: a dimmed backdrop, Escape or a click
 * outside closes it, and Tab stays inside while it is open.
 */
function Dialog({ title, hideTitle = false, className = "", onClose, children }: DialogProps) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const latestClose = useRef(onClose);
  useEffect(() => {
    latestClose.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current;
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        latestClose.current();
        return;
      }
      if (event.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head.focus();
      }
    };
    // Capture, so the library's own Escape (closing the details) waits.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    };
  }, []);

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className={`dialog ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <h2 id={titleId} className={hideTitle ? "visually-hidden" : "dialog-title"}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export default Dialog;
