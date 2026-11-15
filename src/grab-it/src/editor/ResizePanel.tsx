import { useState } from "react";
import { MAX_SCALE, MIN_SCALE, scaledSize, scaleFrom } from "./orient";

interface ResizePanelProps {
  /** The output's size before resizing: the crop as it shows, framed by any backdrop. */
  output: { width: number; height: number };
  /** The resize in force; 1 is the original size. */
  scale: number;
  /** Keeps a new scale: one undo step. */
  onCommit: (scale: number) => void;
}

type Field = "width" | "height" | "percent";

const PERCENTS = [25, 50, 75, 100, 200];

/** The scale a typed value asks for, or null while it is not a usable number. */
function scaleFor(output: ResizePanelProps["output"], field: Field, value: string): number | null {
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) return null;
  if (field === "width") return scaleFrom(output, { width: number });
  if (field === "height") return scaleFrom(output, { height: number });
  return scaleFrom(output, { percent: number });
}

/**
 * The Resize controls: a width and height with the ratio locked, or a
 * percentage. Typing previews the other fields; Enter or leaving the field
 * keeps it.
 */
export default function ResizePanel({ output, scale, onCommit }: ResizePanelProps) {
  const [draft, setDraft] = useState<{ field: Field; value: string } | null>(null);
  const pending = draft ? scaleFor(output, draft.field, draft.value) : null;
  const shownScale = pending ?? scale;
  const shown = scaledSize(output, shownScale);

  const settle = () => {
    if (!draft) return;
    if (pending !== null) onCommit(pending);
    setDraft(null);
  };

  const field = (name: Field, label: string, unit: string) => (
    <label className="backdrop-row resize-row">
      <span>{label}</span>
      <input
        type="number"
        aria-label={label}
        min={1}
        value={draft?.field === name ? draft.value : String(name === "percent" ? Math.round(shownScale * 100) : shown[name])}
        onChange={(event) => setDraft({ field: name, value: event.target.value })}
        onBlur={settle}
        onKeyDown={(event) => {
          if (event.key === "Enter") settle();
        }}
      />
      <output>{unit}</output>
    </label>
  );

  return (
    <div className="backdrop-panel resize-panel" role="dialog" aria-label="Resize">
      {field("width", "Width", "px")}
      {field("height", "Height", "px")}
      {field("percent", "Percent", "%")}
      <div className="backdrop-aspects resize-presets" role="group" aria-label="Size presets">
        {PERCENTS.map((percent) => (
          <button key={percent} type="button" aria-pressed={Math.round(scale * 100) === percent} onClick={() => onCommit(percent / 100)}>
            {percent}%
          </button>
        ))}
      </div>
      <p className="resize-note">
        The aspect ratio stays locked; {Math.round(MIN_SCALE * 100)}% to {Math.round(MAX_SCALE * 100)}% of {output.width}×{output.height}.
      </p>
    </div>
  );
}
