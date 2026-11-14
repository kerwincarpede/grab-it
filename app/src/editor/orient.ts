import type { Annotations, Point, Rect, Rotation } from "./model";

/**
 * How the capture is turned and mirrored on show and on export. Display
 * space is the capture turned `rotation` degrees clockwise, then mirrored,
 * with its top-left corner at 0, 0. Shapes and the crop stay in capture
 * pixels; only what is drawn (and the pointer) passes through this.
 */
export interface Orientation {
  rotation: Rotation;
  flipX: boolean;
  flipY: boolean;
}

export const IDENTITY: Orientation = { rotation: 0, flipX: false, flipY: false };

/** Resize stays within 10% to 400%. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

type Size = { width: number; height: number };

/** The orientation a document asks for; absent fields mean unchanged. */
export function orientationOf(doc: Pick<Annotations, "rotation" | "flipX" | "flipY">): Orientation {
  return { rotation: doc.rotation ?? 0, flipX: Boolean(doc.flipX), flipY: Boolean(doc.flipY) };
}

export function isIdentity(o: Orientation): boolean {
  return o.rotation === 0 && !o.flipX && !o.flipY;
}

/** A whole number of quarter turns, as 0–270; null for anything else. */
export function normalizeRotation(degrees: number): Rotation | null {
  if (!Number.isFinite(degrees) || degrees % 90 !== 0) return null;
  return ((((degrees % 360) + 360) % 360) as Rotation);
}

/** The scale kept within what Resize offers. */
export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** The capture's size on show: width and height swap for a quarter turn. */
export function displaySize(size: Size, o: Orientation): Size {
  return o.rotation === 90 || o.rotation === 270 ? { width: size.height, height: size.width } : { width: size.width, height: size.height };
}

/** The turn and mirror alone, as `[a, b, c, d]`: x' = a·x + c·y, y' = b·x + d·y. */
function linear(o: Orientation): [number, number, number, number] {
  // Clockwise on screen (y points down).
  const [cos, sin] = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[o.rotation];
  const sx = o.flipX ? -1 : 1;
  const sy = o.flipY ? -1 : 1;
  return [sx * cos, sy * sin, -sx * sin, sy * cos];
}

const apply = (m: [number, number, number, number], p: Point): Point => ({ x: m[0] * p.x + m[2] * p.y, y: m[1] * p.x + m[3] * p.y });

/** Where the capture's 0, 0 lands, so the turned capture's top-left is at 0, 0. */
function shift(size: Size, o: Orientation): Point {
  const m = linear(o);
  const corners = [
    { x: 0, y: 0 },
    { x: size.width, y: 0 },
    { x: 0, y: size.height },
    { x: size.width, y: size.height },
  ].map((corner) => apply(m, corner));
  // `|| 0` turns -0 into 0.
  return { x: -Math.min(...corners.map((c) => c.x)) || 0, y: -Math.min(...corners.map((c) => c.y)) || 0 };
}

/** A capture point (in a capture of `size`) on show. */
export function toDisplay(p: Point, size: Size, o: Orientation): Point {
  const at = apply(linear(o), p);
  const by = shift(size, o);
  return { x: at.x + by.x || 0, y: at.y + by.y || 0 };
}

/** A point on show back in capture pixels: where the pointer is on the capture. */
export function toCapture(p: Point, size: Size, o: Orientation): Point {
  const [a, b, c, d] = linear(o);
  const by = shift(size, o);
  const q = { x: p.x - by.x, y: p.y - by.y };
  // The turn and mirror are orthogonal: the inverse is the transpose.
  return { x: a * q.x + b * q.y || 0, y: c * q.x + d * q.y || 0 };
}

/** A rectangle of the capture (the crop) as it shows. */
export function orientRect(rect: Rect, size: Size, o: Orientation): Rect {
  const a = toDisplay({ x: rect.x, y: rect.y }, size, o);
  const b = toDisplay({ x: rect.x + rect.width, y: rect.y + rect.height }, size, o);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/**
 * The Konva attributes that draw a group of capture-pixel content on show.
 * Konva scales before it rotates, so a single mirror turns the other way.
 */
export function groupTransform(size: Size, o: Orientation): { x: number; y: number; rotation: number; scaleX: number; scaleY: number } {
  const by = shift(size, o);
  const mirrored = o.flipX !== o.flipY;
  return {
    ...by,
    rotation: mirrored ? (360 - o.rotation) % 360 : o.rotation,
    scaleX: o.flipX ? -1 : 1,
    scaleY: o.flipY ? -1 : 1,
  };
}

/**
 * Konva attributes that undo the group's turn and mirror for one node
 * inside it, so text and step numbers read upright.
 */
export function uprightTransform(o: Orientation): { rotation: number; scaleX: number; scaleY: number } {
  return { rotation: (360 - o.rotation) % 360, scaleX: o.flipX ? -1 : 1, scaleY: o.flipY ? -1 : 1 };
}

/**
 * Turns what is on show a quarter turn left (-1) or right (1). A turn of a
 * mirrored image swaps which way it is mirrored, so it turns as it shows.
 */
export function rotate(o: Orientation, direction: -1 | 1): Orientation {
  return {
    rotation: ((o.rotation + direction * 90 + 360) % 360) as Rotation,
    flipX: o.flipY,
    flipY: o.flipX,
  };
}

/** Mirrors what is on show left to right ("x") or top to bottom ("y"). */
export function flip(o: Orientation, axis: "x" | "y"): Orientation {
  return axis === "x" ? { ...o, flipX: !o.flipX } : { ...o, flipY: !o.flipY };
}

/** The document fields for an orientation, leaving out what is unchanged. */
export function withOrientation(doc: Annotations, o: Orientation): Annotations {
  const next: Annotations = { ...doc };
  delete next.rotation;
  delete next.flipX;
  delete next.flipY;
  if (o.rotation) next.rotation = o.rotation;
  if (o.flipX) next.flipX = true;
  if (o.flipY) next.flipY = true;
  return next;
}

/** The document with `scale`, leaving it out at 100%. */
export function withScale(doc: Annotations, scale: number): Annotations {
  const next: Annotations = { ...doc };
  delete next.scale;
  const clamped = clampScale(scale);
  if (clamped !== 1) next.scale = clamped;
  return next;
}

/** The size an output of `size` is resized to by `scale`, in whole pixels. */
export function scaledSize(size: Size, scale: number): Size {
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/**
 * The scale that resizes an output of `size` to a new width, a new height
 * (the ratio stays locked) or a percentage. Clamped to 10%–400%; null for
 * a value that is not a positive number.
 */
export function scaleFrom(size: Size, target: { width: number } | { height: number } | { percent: number }): number | null {
  let scale: number;
  if ("width" in target) scale = target.width / size.width;
  else if ("height" in target) scale = target.height / size.height;
  else scale = target.percent / 100;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return clampScale(scale);
}

/**
 * The `area` of `source` turned and mirrored as it shows, on a new canvas:
 * what the blurred backdrop blurs. Null when there is no canvas to draw on.
 */
export function orientedCanvas(source: CanvasImageSource, area: Rect, size: Size, o: Orientation): HTMLCanvasElement | null {
  const shown = orientRect(area, size, o);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(shown.width));
  canvas.height = Math.max(1, Math.round(shown.height));
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;
  const [a, b, c, d] = linear(o);
  const by = shift(size, o);
  ctx.setTransform(a, b, c, d, by.x - shown.x, by.y - shown.y);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

let measuring: CanvasRenderingContext2D | null | undefined;

/**
 * The size of one line of bold annotation text, as Konva draws it (Arial,
 * a line height of 1). Without a canvas to measure on, an estimate.
 */
export function textSize(text: string, fontSize: number): Size {
  if (measuring === undefined) {
    try {
      measuring = document.createElement("canvas").getContext("2d");
    } catch {
      measuring = null;
    }
  }
  let width = text.length * fontSize * 0.6;
  if (measuring) {
    measuring.font = `bold ${fontSize}px Arial`;
    width = measuring.measureText(text).width;
  }
  return { width, height: fontSize };
}

/**
 * Where text that reads upright shows its top-left corner. Upright text
 * turns about its centre, so its corner on show is the centre on show less
 * half its size. Unturned, that is the text's own x, y.
 */
export function shownTextCorner(shape: { x: number; y: number; text: string; fontSize: number }, size: Size, o: Orientation): Point {
  if (isIdentity(o)) return { x: shape.x, y: shape.y };
  const box = textSize(shape.text, shape.fontSize);
  const centre = toDisplay({ x: shape.x + box.width / 2, y: shape.y + box.height / 2 }, size, o);
  return { x: centre.x - box.width / 2, y: centre.y - box.height / 2 };
}

/** The text's x, y in capture pixels that shows its top-left corner at `shown`: the inverse of `shownTextCorner`. */
export function textCorner(shown: Point, text: string, fontSize: number, size: Size, o: Orientation): Point {
  if (isIdentity(o)) return { x: shown.x, y: shown.y };
  const box = textSize(text, fontSize);
  const centre = toCapture({ x: shown.x + box.width / 2, y: shown.y + box.height / 2 }, size, o);
  return { x: centre.x - box.width / 2, y: centre.y - box.height / 2 };
}
