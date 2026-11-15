import { useEffect, useRef, useState } from "react";
import { nearestPreset, type WidthKind } from "./model";

interface WidthControlProps {
  /** What the width sets for the active tool or selected shape. */
  kind: WidthKind;
  /** The width now, in capture pixels; need not be a preset. */
  value: number;
  /** The drawing colour, for the preview. */
  color: string;
  onChange: (width: number) => void;
}

/** The tallest the preview draws a width, so a large one still fits the popover. */
const PREVIEW_MAX = 48;

/**
 * The width button in the top bar and its popover: a preview of the width
 * and a slider over the presets. `[` / `]` and ⌥-scroll change the same
 * width from the keyboard and canvas (see EditorWindow).
 */
export default function WidthControl({ kind, value, color, onChange }: WidthControlProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const index = nearestPreset(kind.presets, value);

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
    // On the window, like the editor's other shortcuts: Escape works from the slider too.
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const shown = Math.min(value, PREVIEW_MAX);
  // A badge's width is its radius.
  const diameter = Math.min(value * 2, PREVIEW_MAX);
  return (
    <div className="bar-group width-anchor" ref={anchor}>
      <button
        type="button"
        className="text-button width-button"
        aria-label={kind.label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`${kind.label}: ${value}px ([ and ], or ⌥-scroll)`}
        onClick={() => setOpen(!open)}
      >
        <span className="width-line" style={{ height: Math.max(1, Math.min(value, 8)) }} />
        <span className="width-value">{value}px</span>
      </button>
      {open && (
        <div className="width-panel" role="dialog" aria-label={kind.label}>
          <div className="width-preview" data-testid="width-preview" data-width={value}>
            {kind.preview === "stroke" && <span className="width-preview-line" style={{ height: shown, background: color }} />}
            {kind.preview === "text" && (
              <span className="width-preview-text" style={{ fontSize: shown, color }}>
                Aa
              </span>
            )}
            {kind.preview === "step" && (
              <span className="width-preview-step" style={{ width: diameter, height: diameter, background: color, fontSize: diameter * 0.55 }}>
                1
              </span>
            )}
          </div>
          <label className="backdrop-row">
            <span>{kind.label}</span>
            <input
              type="range"
              aria-label={kind.label}
              aria-valuetext={`${kind.presets[index]}px`}
              min={0}
              max={kind.presets.length - 1}
              step={1}
              value={index}
              onChange={(event) => onChange(kind.presets[Number(event.target.value)])}
            />
            <output>{value}px</output>
          </label>
        </div>
      )}
    </div>
  );
}
