import {
  BACKDROP_ASPECTS,
  BACKDROP_FILLS,
  BACKDROP_MAX_PADDING,
  BACKDROP_MAX_RADIUS,
  BACKDROP_MESHES,
  BACKDROP_PRESETS,
  BACKDROP_SOLIDS,
  DEFAULT_BACKDROP,
  DEFAULT_GRADIENT,
  DEFAULT_SHADOW_SIZE,
  DEFAULT_SHADOW_STRENGTH,
  type Backdrop,
} from "./model";

interface BackdropPanelProps {
  /** The backdrop on show, or null when it is off. */
  backdrop: Backdrop | null;
  /** What picking a fill starts from while the backdrop is off: the last backdrop used. */
  start?: Backdrop | null;
  /** Shows a value while a slider or the colour picker is still moving. */
  onPreview: (backdrop: Backdrop) => void;
  /** Keeps a value: one undo step. */
  onCommit: (backdrop: Backdrop | null) => void;
  /** Asks for an image file; resolves to its path, or null when cancelled. */
  onPickImage: () => Promise<string | null>;
}

const isHex = (fill: string) => /^#[0-9a-f]{6}$/i.test(fill);

/** A mesh as CSS, for its swatch: the same blobs over the same base colour. */
function meshCss(mesh: (typeof BACKDROP_MESHES)[number]): string {
  const blobs = mesh.blobs.map(
    (blob) => `radial-gradient(circle at ${blob.x * 100}% ${blob.y * 100}%, ${blob.color}, ${blob.color}00 ${blob.radius * 100}%)`,
  );
  return [...blobs, mesh.base].join(", ");
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The backdrop with Balance on, or without the field when it is off, as older sidecars have it. */
function withBalance(backdrop: Backdrop, balance: boolean): Backdrop {
  const next = { ...backdrop };
  if (balance) next.balance = true;
  else delete next.balance;
  return next;
}

/**
 * The backdrop ("beautify") controls: fill (gradients, meshes, solids, the
 * blurred capture, an image), padding and Balance, aspect ratio, corner
 * radius and shadow.
 */
export default function BackdropPanel({ backdrop, start, onPreview, onCommit, onPickImage }: BackdropPanelProps) {
  // Picking a fill turns the backdrop on with the sizes last used.
  const current = backdrop ?? start ?? DEFAULT_BACKDROP;
  // A drag previews every step and commits once, when it is let go.
  const settle = () => backdrop && onCommit(backdrop);
  const gradient = current.gradient ?? DEFAULT_GRADIENT;
  const shadowSize = current.shadowSize ?? DEFAULT_SHADOW_SIZE;
  const shadowStrength = current.shadowStrength ?? DEFAULT_SHADOW_STRENGTH;

  const slider = (
    label: string,
    value: number,
    max: number,
    unit: string,
    change: (value: number) => Backdrop,
    disabled = !backdrop,
  ) => (
    <label className="backdrop-row">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onPreview(change(Number(event.target.value)))}
        onPointerUp={settle}
        onKeyUp={settle}
        onBlur={settle}
      />
      <output>
        {value}
        {unit}
      </output>
    </label>
  );

  const swatch = (fill: string, label: string, background: string, extra: Partial<Backdrop> = {}, className = "") => (
    <button
      key={fill}
      type="button"
      className={`backdrop-swatch ${className}`.trim()}
      style={{ background }}
      aria-label={label}
      title={label}
      aria-pressed={backdrop?.fill === fill}
      onClick={() => onCommit({ ...current, ...extra, fill })}
    />
  );

  const pickImage = async () => {
    const path = await onPickImage().catch(() => null);
    if (path) onCommit({ ...current, fill: BACKDROP_FILLS.image, image: path });
  };

  return (
    <div className="backdrop-panel" role="dialog" aria-label="Backdrop">
      <div className="backdrop-section">Gradients</div>
      <div className="backdrop-swatches" role="group" aria-label="Gradients">
        <button
          type="button"
          className="backdrop-swatch none"
          aria-label="No backdrop"
          title="No backdrop"
          aria-pressed={!backdrop}
          onClick={() => onCommit(null)}
        />
        {BACKDROP_PRESETS.map((preset) => swatch(preset.id, `${preset.label} gradient`, `linear-gradient(135deg, ${preset.colors.join(", ")})`))}
        {swatch(
          BACKDROP_FILLS.custom,
          "Custom gradient",
          `linear-gradient(${gradient.angle}deg, ${gradient.from}, ${gradient.to})`,
          { gradient },
          "custom-gradient",
        )}
      </div>
      {backdrop?.fill === BACKDROP_FILLS.custom && (
        <div className="backdrop-gradient">
          <input
            type="color"
            className="backdrop-swatch"
            aria-label="Gradient start colour"
            title="Start colour"
            value={gradient.from}
            onChange={(event) => onPreview({ ...current, gradient: { ...gradient, from: event.target.value } })}
            onBlur={settle}
          />
          <input
            type="color"
            className="backdrop-swatch"
            aria-label="Gradient end colour"
            title="End colour"
            value={gradient.to}
            onChange={(event) => onPreview({ ...current, gradient: { ...gradient, to: event.target.value } })}
            onBlur={settle}
          />
          {slider("Angle", gradient.angle, 359, "°", (angle) => ({ ...current, gradient: { ...gradient, angle } }))}
        </div>
      )}
      <div className="backdrop-section">Mesh</div>
      <div className="backdrop-swatches" role="group" aria-label="Mesh">
        {BACKDROP_MESHES.map((mesh) => swatch(mesh.id, `${mesh.label} mesh`, meshCss(mesh)))}
      </div>
      <div className="backdrop-section">Solids</div>
      <div className="backdrop-swatches" role="group" aria-label="Solids">
        {BACKDROP_SOLIDS.map((solid) => swatch(solid.fill, solid.label, solid.fill))}
        <input
          type="color"
          className="backdrop-swatch"
          aria-label="Custom backdrop colour"
          title="Custom colour"
          value={isHex(current.fill) ? current.fill : "#4c8dff"}
          onChange={(event) => onPreview({ ...current, fill: event.target.value })}
          onBlur={settle}
        />
        {swatch(BACKDROP_FILLS.transparent, "Transparent", "", {}, "transparent")}
        {swatch(BACKDROP_FILLS.blur, "Blurred capture", "", {}, "blurred")}
        <button
          type="button"
          className="backdrop-swatch image"
          aria-label="Image"
          title={current.image ? `Image: ${fileName(current.image)} (click to choose another)` : "Choose an image…"}
          aria-pressed={backdrop?.fill === BACKDROP_FILLS.image}
          onClick={() => void pickImage()}
        />
      </div>
      {slider("Padding", current.padding, BACKDROP_MAX_PADDING, "px", (padding) => ({ ...current, padding }))}
      <label className="backdrop-row check" title="Pads unevenly so a capture with empty margins looks centred">
        <input
          type="checkbox"
          checked={backdrop?.balance ?? false}
          disabled={!backdrop}
          onChange={(event) => onCommit(withBalance(current, event.target.checked))}
        />
        <span>Balance</span>
      </label>
      <div className="backdrop-row">
        <span>Aspect ratio</span>
        <div className="backdrop-aspects" role="group" aria-label="Aspect ratio">
          {BACKDROP_ASPECTS.map((entry) => (
            <button
              key={entry.aspect}
              type="button"
              disabled={!backdrop}
              aria-pressed={(current.aspect ?? "auto") === entry.aspect}
              onClick={() => onCommit({ ...current, aspect: entry.aspect })}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>
      {/* Moving the radius puts it in points; an older backdrop's pixel radius shows as pixels until then. */}
      {slider("Corner radius", current.radius, BACKDROP_MAX_RADIUS, current.radiusUnit === "pt" ? "pt" : "px", (radius) => ({
        ...current,
        radius,
        radiusUnit: "pt",
      }))}
      <label className="backdrop-row check">
        <input
          type="checkbox"
          checked={backdrop?.shadow ?? false}
          disabled={!backdrop}
          onChange={(event) => onCommit({ ...current, shadow: event.target.checked })}
        />
        <span>Shadow</span>
      </label>
      {slider("Shadow size", shadowSize, 100, "%", (size) => ({ ...current, shadowSize: size }), !backdrop?.shadow)}
      {slider("Shadow strength", shadowStrength, 100, "%", (strength) => ({ ...current, shadowStrength: strength }), !backdrop?.shadow)}
    </div>
  );
}
