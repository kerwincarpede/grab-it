import {
  BACKDROP_MAX_PADDING,
  BACKDROP_MAX_RADIUS,
  BACKDROP_PRESETS,
  BACKDROP_SOLIDS,
  DEFAULT_BACKDROP,
  type Backdrop,
} from "./model";

interface BackdropPanelProps {
  /** The backdrop on show, or null when it is off. */
  backdrop: Backdrop | null;
  /** Shows a value while a slider or the colour picker is still moving. */
  onPreview: (backdrop: Backdrop) => void;
  /** Keeps a value: one undo step. */
  onCommit: (backdrop: Backdrop | null) => void;
}

const isHex = (fill: string) => /^#[0-9a-f]{6}$/i.test(fill);

/** The backdrop ("beautify") controls: fill, padding, corner radius and shadow. */
export default function BackdropPanel({ backdrop, onPreview, onCommit }: BackdropPanelProps) {
  // Picking a fill turns the backdrop on with these sizes.
  const current = backdrop ?? DEFAULT_BACKDROP;
  // A drag previews every step and commits once, when it is let go.
  const settle = () => backdrop && onCommit(backdrop);
  const slider = (label: string, field: "padding" | "radius", max: number) => (
    <label className="backdrop-row">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max}
        value={current[field]}
        disabled={!backdrop}
        onChange={(event) => onPreview({ ...current, [field]: Number(event.target.value) })}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
      />
      <output>{current[field]}px</output>
    </label>
  );

  return (
    <div className="backdrop-panel" role="dialog" aria-label="Backdrop">
      <div className="backdrop-swatches" role="group" aria-label="Backdrop fill">
        <button
          type="button"
          className="backdrop-swatch none"
          aria-label="No backdrop"
          title="No backdrop"
          aria-pressed={!backdrop}
          onClick={() => onCommit(null)}
        />
        {BACKDROP_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="backdrop-swatch"
            style={{ background: `linear-gradient(135deg, ${preset.colors.join(", ")})` }}
            aria-label={`${preset.label} gradient`}
            title={preset.label}
            aria-pressed={backdrop?.fill === preset.id}
            onClick={() => onCommit({ ...current, fill: preset.id })}
          />
        ))}
        {BACKDROP_SOLIDS.map((solid) => (
          <button
            key={solid.fill}
            type="button"
            className="backdrop-swatch"
            style={{ background: solid.fill }}
            aria-label={solid.label}
            title={solid.label}
            aria-pressed={backdrop?.fill === solid.fill}
            onClick={() => onCommit({ ...current, fill: solid.fill })}
          />
        ))}
        <input
          type="color"
          className="backdrop-swatch"
          aria-label="Custom backdrop colour"
          title="Custom colour"
          value={isHex(current.fill) ? current.fill : "#4c8dff"}
          onChange={(event) => onPreview({ ...current, fill: event.target.value })}
          onBlur={settle}
        />
      </div>
      {slider("Padding", "padding", BACKDROP_MAX_PADDING)}
      {slider("Corner radius", "radius", BACKDROP_MAX_RADIUS)}
      <label className="backdrop-row check">
        <input
          type="checkbox"
          checked={backdrop?.shadow ?? false}
          disabled={!backdrop}
          onChange={(event) => onCommit({ ...current, shadow: event.target.checked })}
        />
        <span>Shadow</span>
      </label>
    </div>
  );
}
