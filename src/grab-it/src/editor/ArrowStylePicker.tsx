import { useLayoutEffect, useRef, useState } from "react";
import { ARROW_STYLES, ARROW_STYLE_GROUPS, arrowGeometry, type ArrowStyle } from "./arrowStyles";

const OPTION_STEP: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 };

function ArrowPreview({ style, color, compact = false }: { style: ArrowStyle; color: string; compact?: boolean }) {
  const { parts } = arrowGeometry({
    id: "preview",
    type: "arrow",
    color,
    strokeWidth: 2,
    arrowStyle: style,
    points: style === "elbow" ? [9, 7, 63, 25] : [9, 16, 63, 16],
    ...(style === "elbow" ? { elbow: { axis: "x", at: 35 } } : {}),
  });
  return (
    <svg width={compact ? 30 : 72} height={compact ? 15 : 32} viewBox="0 0 72 32" aria-hidden="true" focusable="false">
      {parts.map(({ path, strokeWidth }, index) => (
        <path
          key={index}
          d={path}
          fill={strokeWidth === undefined ? color : "none"}
          stroke={strokeWidth === undefined ? "none" : color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

export default function ArrowStylePicker({ value, color, onPick }: {
  value: ArrowStyle;
  color: string;
  onPick: (style: ArrowStyle) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const label = ARROW_STYLES.find(({ id }) => id === value)?.label;

  const closeAndFocus = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  useLayoutEffect(() => {
    if (!open) return;
    const button = trigger.current;
    const dialog = panel.current;
    if (!button || !dialog) return;
    const place = () => {
      const { left, bottom } = button.getBoundingClientRect();
      const gutter = 8;
      const width = Math.min(390, window.innerWidth - gutter * 2);
      const top = bottom + gutter;
      dialog.style.width = `${width}px`;
      dialog.style.left = `${Math.max(gutter, Math.min(left, window.innerWidth - width - gutter))}px`;
      dialog.style.top = `${top}px`;
      dialog.style.maxHeight = `${Math.max(0, Math.min(460, window.innerHeight - top - gutter))}px`;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    };
    place();
    dialog.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (anchor.current?.parentElement) observer?.observe(anchor.current.parentElement);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [open]);

  return (
    <div className="bar-group" ref={anchor}>
      <button
        ref={trigger}
        type="button"
        className="text-button"
        aria-label="Style"
        title={`Arrow style: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ArrowPreview style={value} color={color} compact />
        <span>Style</span>
      </button>
      {open && (
        <div
          ref={panel}
          className="arrow-style-panel"
          role="dialog"
          aria-label="Arrow style"
          onKeyDown={(event) => {
            // The canvas also uses the arrow keys to nudge a selection.
            const offset = OPTION_STEP[event.key];
            if (!offset) return;
            const options = Array.from(event.currentTarget.querySelectorAll("button"));
            const at = options.findIndex((option) => option === document.activeElement);
            if (at < 0) return;
            event.preventDefault();
            event.stopPropagation();
            options[(at + offset + options.length) % options.length]?.focus();
          }}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !anchor.current?.contains(event.relatedTarget)) setOpen(false);
          }}
        >
          {ARROW_STYLE_GROUPS.map(({ label, styles }) => (
            <div key={label} className="arrow-style-section" role="group" aria-label={label}>
              <span className="stamp-section-label">{label}</span>
              <div className="arrow-style-grid">
                {styles.map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={id === value}
                    onClick={() => {
                      onPick(id);
                      closeAndFocus();
                    }}
                  >
                    <ArrowPreview style={id} color={color} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
