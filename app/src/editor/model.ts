/** Annotation shapes, in capture pixels. Stored in `<capture>.annotations.json`. */

export type Tool =
  | "select"
  | "pan"
  | "arrow"
  | "rect"
  | "ellipse"
  | "line"
  | "freehand"
  | "text"
  | "highlighter"
  | "blur"
  | "spotlight"
  | "step"
  | "crop";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Stroked {
  id: string;
  color: string;
  strokeWidth: number;
}

/**
 * Two points: `[x1, y1, x2, y2]`. With `control`, a quadratic curve bent
 * towards that point; without it (every sidecar from before curves), straight.
 */
export interface LineShape extends Stroked {
  type: "arrow" | "line";
  points: number[];
  /** The quadratic curve's control point, `[cx, cy]`. */
  control?: [number, number];
}

/** A drawn path: `[x1, y1, x2, y2, ...]`. */
export interface PathShape extends Stroked {
  type: "freehand" | "highlighter";
  points: number[];
}

export interface BoxShape extends Stroked, Rect {
  type: "rect" | "ellipse";
  /** Filled with the colour at `FILL_OPACITY`; absent means outline only. */
  fill?: boolean;
}

export type BlurMode = "pixelate" | "blur";

/** Hides the capture under it: pixelated (the default) or smoothly blurred. */
export interface BlurShape extends Rect {
  id: string;
  type: "blur";
  pixelSize: number;
  mode?: BlurMode;
}

/** Keeps its area bright; everything outside every spotlight is dimmed. */
export interface SpotlightShape extends Rect {
  id: string;
  type: "spotlight";
}

export interface TextShape {
  id: string;
  type: "text";
  color: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
  /** Drawn on a rounded pill of the colour, in a contrasting text colour. */
  background?: boolean;
}

/** A numbered badge centred on x, y; numbered by its order among steps. */
export interface StepShape {
  id: string;
  type: "step";
  color: string;
  x: number;
  y: number;
  radius: number;
}

export type Shape = LineShape | PathShape | BoxShape | BlurShape | SpotlightShape | TextShape | StepShape;
export type ShapeType = Shape["type"];

/** The output shapes a backdrop can pad the capture to; "auto" pads evenly. */
export type BackdropAspect = "auto" | "16:9" | "4:3" | "1:1";

/** A two-colour gradient the user mixed, at a CSS angle (0 is bottom to top, 90 left to right). */
export interface CustomGradient {
  from: string;
  to: string;
  angle: number;
}

/**
 * A decorative frame around the capture, added on copy/export. `fill` is a
 * `BACKDROP_PRESETS` or `BACKDROP_MESHES` id, a hex colour, or one of the
 * `BACKDROP_FILLS`. `padding` is in capture pixels; `radius` is in points,
 * multiplied by the capture's scale factor, when `radiusUnit` is "pt", and
 * in capture pixels otherwise (sidecars written before points).
 *
 * Every field after `shadow` came later and is optional, so sidecars from
 * before still load and look as they did.
 */
export interface Backdrop {
  fill: string;
  padding: number;
  radius: number;
  shadow: boolean;
  /** "pt" for a radius in points; absent in older sidecars, whose radius is in pixels. */
  radiusUnit?: "pt";
  /** How far the shadow spreads, 0–100; `DEFAULT_SHADOW_SIZE` when absent. */
  shadowSize?: number;
  /** How dark the shadow is, 0–100; `DEFAULT_SHADOW_STRENGTH` when absent. */
  shadowStrength?: number;
  /** "auto" when absent. */
  aspect?: BackdropAspect;
  /** The colours and angle of the `custom` fill. */
  gradient?: CustomGradient;
  /** The file the `image` fill shows. */
  image?: string;
}

/**
 * The sidecar document. `crop` and `backdrop` are non-destructive: applied
 * on copy/export, crop first.
 */
export interface Annotations {
  version: 1;
  shapes: Shape[];
  crop?: Rect | null;
  backdrop?: Backdrop | null;
}

/** What the next shape is drawn with. */
export interface Style {
  color: string;
  strokeWidth: number;
  /** Text font size; `DEFAULT_FONT_SIZE` when absent. */
  fontSize?: number;
  /** Step badge radius; `DEFAULT_STEP_RADIUS` when absent. */
  stepRadius?: number;
  /** Rectangles and ellipses are filled. */
  fill?: boolean;
  /** Text sits on a pill. */
  background?: boolean;
  blurMode?: BlurMode;
}

export const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0090ff", "#8e4ec6", "#1f2328", "#ffffff"];
export const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8, 12, 16, 24];
export const DEFAULT_STROKE_WIDTH = 4;
/** Text sizes; the default matches what the old default width gave text. */
export const FONT_SIZES = [12, 16, 20, 24, 30, 36, 48, 64, 96];
export const DEFAULT_FONT_SIZE = 30;
/** Step badge radii; the default matches what the old default width gave badges. */
export const STEP_RADII = [10, 12, 14, 16, 20, 24, 30, 36, 48];
export const DEFAULT_STEP_RADIUS = 20;
export const DEFAULT_STYLE: Style = { color: COLORS[0], strokeWidth: DEFAULT_STROKE_WIDTH };

/**
 * Each tool's own width, by tool: the stroke width for stroked tools, the
 * font size for text and the badge radius for steps. A missing tool uses
 * its default.
 */
export type Widths = Partial<Record<Tool, number>>;

/** What a tool's width sets, and the choices offered for it. */
export interface WidthKind {
  /** Names the control: "Width" for strokes, "Size" for text and badges. */
  label: string;
  /** What the width popover previews: a line, a line of text or a badge. */
  preview: "stroke" | "text" | "step";
  presets: number[];
  fallback: number;
}

const STROKE_KIND: WidthKind = { label: "Width", preview: "stroke", presets: STROKE_WIDTHS, fallback: DEFAULT_STROKE_WIDTH };
const FONT_KIND: WidthKind = { label: "Text size", preview: "text", presets: FONT_SIZES, fallback: DEFAULT_FONT_SIZE };
const STEP_KIND: WidthKind = { label: "Badge size", preview: "step", presets: STEP_RADII, fallback: DEFAULT_STEP_RADIUS };

/** The width a tool (or a shape of that type) takes, or null when it has none (blur, crop…). */
export function widthKind(tool: Tool | ShapeType): WidthKind | null {
  switch (tool) {
    case "arrow":
    case "line":
    case "rect":
    case "ellipse":
    case "freehand":
    case "highlighter":
      return STROKE_KIND;
    case "text":
      return FONT_KIND;
    case "step":
      return STEP_KIND;
    default:
      return null;
  }
}

/** The width `tool` draws with: its remembered one, else its default. */
export function widthFor(widths: Widths, tool: Tool | ShapeType): number {
  return widths[tool] ?? widthKind(tool)?.fallback ?? DEFAULT_STROKE_WIDTH;
}

/** The index of the preset closest to `value`, for a slider over the presets. */
export function nearestPreset(presets: number[], value: number): number {
  let best = 0;
  presets.forEach((preset, i) => {
    if (Math.abs(preset - value) < Math.abs(presets[best] - value)) best = i;
  });
  return best;
}

/** Opacity of a filled rectangle or ellipse. */
export const FILL_OPACITY = 0.25;
/** How dark the area outside the spotlights is. */
export const SPOTLIGHT_DIM = 0.55;

/** Tools in rail order; a separator is drawn between groups. */
export const TOOLS: { tool: Tool; label: string; key: string; group: number }[] = [
  { tool: "select", label: "Select", key: "v", group: 0 },
  { tool: "pan", label: "Pan", key: "m", group: 0 },
  { tool: "arrow", label: "Arrow", key: "a", group: 1 },
  { tool: "line", label: "Line", key: "l", group: 1 },
  { tool: "rect", label: "Rectangle", key: "r", group: 1 },
  { tool: "ellipse", label: "Ellipse", key: "e", group: 1 },
  { tool: "freehand", label: "Freehand", key: "p", group: 1 },
  { tool: "text", label: "Text", key: "t", group: 2 },
  { tool: "step", label: "Step", key: "n", group: 2 },
  { tool: "highlighter", label: "Highlighter", key: "h", group: 2 },
  { tool: "blur", label: "Blur", key: "b", group: 3 },
  { tool: "spotlight", label: "Spotlight", key: "s", group: 3 },
  { tool: "crop", label: "Crop", key: "c", group: 4 },
];

export const BACKDROP_MAX_PADDING = 200;
/** Corner radius, in points. */
export const BACKDROP_MAX_RADIUS = 80;
export const DEFAULT_BACKDROP_RADIUS = 36;
/** The shadow sliders run 0–100; these defaults give the shadow backdrops always had. */
export const DEFAULT_SHADOW_SIZE = 50;
export const DEFAULT_SHADOW_STRENGTH = 35;

export const BACKDROP_ASPECTS: { aspect: BackdropAspect; label: string; ratio: number | null }[] = [
  { aspect: "auto", label: "Auto", ratio: null },
  { aspect: "16:9", label: "16:9", ratio: 16 / 9 },
  { aspect: "4:3", label: "4:3", ratio: 4 / 3 },
  { aspect: "1:1", label: "1:1", ratio: 1 },
];

/** Gradient backdrops, drawn corner to corner (top-left to bottom-right). */
export const BACKDROP_PRESETS: { id: string; label: string; colors: string[] }[] = [
  { id: "ocean", label: "Ocean", colors: ["#4c8dff", "#7b5cff"] },
  { id: "sunset", label: "Sunset", colors: ["#ff9a5a", "#ff5e7e"] },
  { id: "aurora", label: "Aurora", colors: ["#3ddc97", "#2b8cff"] },
  { id: "grape", label: "Grape", colors: ["#a56bff", "#ff6ac1"] },
  { id: "peach", label: "Peach", colors: ["#ffd3a5", "#fd9bb0"] },
  { id: "mint", label: "Mint", colors: ["#c6f6d5", "#7fd8e8"] },
  { id: "dusk", label: "Dusk", colors: ["#2b3a67", "#7a4b94"] },
  { id: "slate", label: "Slate", colors: ["#525c6b", "#22272e"] },
  { id: "flamingo", label: "Flamingo", colors: ["#ffb199", "#ff6cab", "#7366ff"] },
  { id: "lagoon", label: "Lagoon", colors: ["#00c6fb", "#3ddc97", "#f9f871"] },
  { id: "ember", label: "Ember", colors: ["#f9d423", "#ff4e50", "#8e2de2"] },
  { id: "nebula", label: "Nebula", colors: ["#0f0c29", "#302b63", "#b06ab3"] },
];

/** A soft blob of colour in a mesh: centred at x, y (0–1 of the output), reaching `radius` of its longer side. */
export interface MeshBlob {
  x: number;
  y: number;
  radius: number;
  color: string;
}

/** Mesh backdrops: soft radial blobs of colour layered over a base colour. */
export const BACKDROP_MESHES: { id: string; label: string; base: string; blobs: MeshBlob[] }[] = [
  {
    id: "mesh-bloom",
    label: "Bloom",
    base: "#ffb6c9",
    blobs: [
      { x: 0, y: 0, radius: 0.9, color: "#ffd36e" },
      { x: 1, y: 0.2, radius: 0.8, color: "#ff6ac1" },
      { x: 0.2, y: 1, radius: 0.8, color: "#8f7bff" },
    ],
  },
  {
    id: "mesh-lagoon",
    label: "Tide",
    base: "#3a7bd5",
    blobs: [
      { x: 0, y: 1, radius: 0.9, color: "#00d2a8" },
      { x: 1, y: 0, radius: 0.9, color: "#6a5cff" },
      { x: 0.6, y: 0.6, radius: 0.5, color: "#7fe7ff" },
    ],
  },
  {
    id: "mesh-sorbet",
    label: "Sorbet",
    base: "#ffe1c4",
    blobs: [
      { x: 0.1, y: 0.2, radius: 0.7, color: "#ff9a8b" },
      { x: 0.9, y: 0.9, radius: 0.8, color: "#ffd86f" },
      { x: 0.9, y: 0.1, radius: 0.6, color: "#a0e7ff" },
    ],
  },
  {
    id: "mesh-midnight",
    label: "Midnight",
    base: "#0b1026",
    blobs: [
      { x: 0.1, y: 0.1, radius: 0.8, color: "#3b2fa0" },
      { x: 1, y: 0.8, radius: 0.8, color: "#b0306a" },
      { x: 0.5, y: 1, radius: 0.5, color: "#1f6feb" },
    ],
  },
  {
    id: "mesh-meadow",
    label: "Meadow",
    base: "#c9f2c7",
    blobs: [
      { x: 0, y: 0, radius: 0.8, color: "#7ee8a9" },
      { x: 1, y: 0.4, radius: 0.8, color: "#fbe37b" },
      { x: 0.3, y: 1, radius: 0.7, color: "#5fc4e8" },
    ],
  },
  {
    id: "mesh-ember",
    label: "Glow",
    base: "#2a0a18",
    blobs: [
      { x: 0, y: 1, radius: 0.9, color: "#ff5e3a" },
      { x: 1, y: 0, radius: 0.8, color: "#ff2a68" },
      { x: 0.7, y: 0.8, radius: 0.5, color: "#ffb347" },
    ],
  },
];

export const BACKDROP_SOLIDS: { fill: string; label: string }[] = [
  { fill: "#ffffff", label: "White" },
  { fill: "#000000", label: "Black" },
];

/** Fills that are not a colour: the user's gradient, the capture blurred, nothing, or a picked image. */
export const BACKDROP_FILLS = { custom: "custom", blur: "blur", transparent: "transparent", image: "image" } as const;

export const DEFAULT_GRADIENT: CustomGradient = { from: "#4c8dff", to: "#ff6ac1", angle: 135 };

export const DEFAULT_BACKDROP: Backdrop = {
  fill: BACKDROP_PRESETS[0].id,
  padding: 64,
  radius: DEFAULT_BACKDROP_RADIUS,
  radiusUnit: "pt",
  shadow: true,
};

export function sameBackdrop(a: Backdrop | null | undefined, b: Backdrop | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.fill === b.fill &&
    a.padding === b.padding &&
    a.radius === b.radius &&
    a.radiusUnit === b.radiusUnit &&
    a.shadow === b.shadow &&
    a.shadowSize === b.shadowSize &&
    a.shadowStrength === b.shadowStrength &&
    (a.aspect ?? "auto") === (b.aspect ?? "auto") &&
    a.gradient?.from === b.gradient?.from &&
    a.gradient?.to === b.gradient?.to &&
    a.gradient?.angle === b.gradient?.angle &&
    a.image === b.image
  );
}

/** The colours a backdrop fill paints: one for a solid, several for a gradient. */
export function backdropColors(fill: string): string[] {
  return BACKDROP_PRESETS.find((preset) => preset.id === fill)?.colors ?? [fill];
}

export function emptyAnnotations(): Annotations {
  return { version: 1, shapes: [], crop: null };
}
