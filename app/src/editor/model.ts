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

/** Two points: `[x1, y1, x2, y2]`. */
export interface LineShape extends Stroked {
  type: "arrow" | "line";
  points: number[];
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

/**
 * A decorative frame around the capture, added on copy/export. `fill` is a
 * `BACKDROP_PRESETS` id or a hex colour; `padding` and `radius` are in
 * capture pixels.
 */
export interface Backdrop {
  fill: string;
  padding: number;
  radius: number;
  shadow: boolean;
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
  /** Rectangles and ellipses are filled. */
  fill?: boolean;
  /** Text sits on a pill. */
  background?: boolean;
  blurMode?: BlurMode;
}

export const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0090ff", "#8e4ec6", "#1f2328", "#ffffff"];
export const STROKE_WIDTHS = [2, 4, 6, 10];
export const DEFAULT_STYLE: Style = { color: COLORS[0], strokeWidth: 4 };

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
export const BACKDROP_MAX_RADIUS = 48;

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
];

export const BACKDROP_SOLIDS: { fill: string; label: string }[] = [
  { fill: "#ffffff", label: "White" },
  { fill: "#000000", label: "Black" },
];

export const DEFAULT_BACKDROP: Backdrop = { fill: BACKDROP_PRESETS[0].id, padding: 64, radius: 12, shadow: true };

export function sameBackdrop(a: Backdrop | null | undefined, b: Backdrop | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.fill === b.fill && a.padding === b.padding && a.radius === b.radius && a.shadow === b.shadow;
}

/** The colours a backdrop fill paints: one for a solid, several for a gradient. */
export function backdropColors(fill: string): string[] {
  return BACKDROP_PRESETS.find((preset) => preset.id === fill)?.colors ?? [fill];
}

export function emptyAnnotations(): Annotations {
  return { version: 1, shapes: [], crop: null };
}
