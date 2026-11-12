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
}

/** Pixelates the capture under it. */
export interface BlurShape extends Rect {
  id: string;
  type: "blur";
  pixelSize: number;
}

export interface TextShape {
  id: string;
  type: "text";
  color: string;
  x: number;
  y: number;
  text: string;
  fontSize: number;
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

export type Shape = LineShape | PathShape | BoxShape | BlurShape | TextShape | StepShape;
export type ShapeType = Shape["type"];

/** The sidecar document. `crop` is non-destructive: applied on copy/export. */
export interface Annotations {
  version: 1;
  shapes: Shape[];
  crop?: Rect | null;
}

export interface Style {
  color: string;
  strokeWidth: number;
}

export const COLORS = ["#e5484d", "#f5a524", "#30a46c", "#0090ff", "#8e4ec6", "#1f2328", "#ffffff"];
export const STROKE_WIDTHS = [2, 4, 6, 10];
export const DEFAULT_STYLE: Style = { color: COLORS[0], strokeWidth: 4 };

export const TOOLS: { tool: Tool; label: string; key: string }[] = [
  { tool: "select", label: "Select", key: "v" },
  { tool: "pan", label: "Pan", key: "m" },
  { tool: "arrow", label: "Arrow", key: "a" },
  { tool: "rect", label: "Rectangle", key: "r" },
  { tool: "ellipse", label: "Ellipse", key: "e" },
  { tool: "line", label: "Line", key: "l" },
  { tool: "freehand", label: "Freehand", key: "p" },
  { tool: "text", label: "Text", key: "t" },
  { tool: "highlighter", label: "Highlighter", key: "h" },
  { tool: "blur", label: "Blur", key: "b" },
  { tool: "step", label: "Step", key: "n" },
  { tool: "crop", label: "Crop", key: "c" },
];

export function emptyAnnotations(): Annotations {
  return { version: 1, shapes: [], crop: null };
}
