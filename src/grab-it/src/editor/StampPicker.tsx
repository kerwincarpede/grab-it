import { useEffect, useRef, useState } from "react";
import { PICKER_SECTIONS, pickLabel, stampDef, stampPick } from "./stamps";
import { contrastColor } from "./tools";

/** A picker entry drawn as the canvas draws it, `size` CSS pixels on its longer side. */
export function StampPreview({ id, color, size = 24 }: { id: string; color: string; size?: number }) {
  const pick = stampPick(id);
  const def = pick ? stampDef(pick.name) : undefined;
  if (!pick || !def) return null;
  if (def.kind === "icon") {
    return (
      <svg className="stamp-preview" width={size} height={size} viewBox="-2 -2 28 28" aria-hidden="true" focusable="false">
        {def.parts?.map((part, i) =>
          part.paint === "stroke" ? (
            <g key={i} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d={part.d} stroke="#ffffff" strokeWidth={6} />
              <path d={part.d} stroke={color} strokeWidth={3} />
            </g>
          ) : part.paint === "fill" ? (
            <path key={i} d={part.d} fill={color} stroke="#ffffff" strokeWidth={1.5} strokeLinejoin="round" />
          ) : (
            <path key={i} d={part.d} fill="none" stroke={contrastColor(color)} strokeWidth={2.4} strokeLinecap="round" />
          ),
        )}
      </svg>
    );
  }
  if (def.kind === "keycap") {
    return (
      <span className="stamp-preview stamp-keycap" style={{ background: color, color: contrastColor(color), height: size, minWidth: size }}>
        {pick.label ?? "Aa"}
      </span>
    );
  }
  return <img className="stamp-preview" src={def.url} alt="" width={size} height={size} draggable={false} />;
}

interface StampPickerProps {
  /** The pick on show: the selected stamp's, else the one the Stamp tool places. */
  value: string;
  /** The drawing colour, for icons and keycaps. */
  color: string;
  onPick: (id: string) => void;
}

/**
 * The stamp button in the top bar and its popover: every bundled stamp in
 * sections, icons, pointers, keys and emoji. Picking one sets what the Stamp
 * tool places, and swaps a selected stamp for it.
 */
export default function StampPicker({ value, color, onPick }: StampPickerProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);

  // A click outside, or Escape, closes the popover.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const label = pickLabel(value);
  return (
    <div className="bar-group stamp-anchor" ref={anchor}>
      <button
        type="button"
        className="text-button stamp-button"
        aria-label="Choose stamp"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Stamp: ${label}`}
        onClick={() => setOpen(!open)}
      >
        <StampPreview id={value} color={color} size={18} />
        <span className="stamp-name">{label}</span>
      </button>
      {open && (
        <div className="stamp-panel" role="dialog" aria-label="Stamps">
          {PICKER_SECTIONS.map((section) => (
            <div key={section.label} className="stamp-section" role="group" aria-label={section.label}>
              <span className="stamp-section-label">{section.label}</span>
              <div className="stamp-grid">
                {section.ids.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="stamp-choice"
                    aria-label={pickLabel(id)}
                    aria-pressed={id === value}
                    title={pickLabel(id)}
                    onClick={() => {
                      onPick(id);
                      setOpen(false);
                    }}
                  >
                    <StampPreview id={id} color={color} />
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
