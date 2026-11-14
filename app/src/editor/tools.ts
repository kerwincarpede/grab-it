import {
  COLORS,
  CROP_ASPECTS,
  DEFAULT_STEP_RADIUS,
  STROKE_WIDTHS,
  type Annotations,
  type CropAspect,
  type LineShape,
  type Point,
  type Rect,
  type Shape,
  type Style,
  type Tool,
} from "./model";
import { toCapture, type Orientation } from "./orient";

/** How far a duplicate lands from its original, in capture pixels. */
export const DUPLICATE_OFFSET = 12;
/** Shapes smaller than this many pixels are treated as a stray click. */
export const MIN_SIZE = 3;
export const HIGHLIGHTER_WIDTH = 18;
/** The highlighter is drawn wider than the width picked: three times it, and never thinner than `HIGHLIGHTER_WIDTH`. */
export function highlighterWidth(strokeWidth: number): number {
  return Math.max(HIGHLIGHTER_WIDTH, strokeWidth * 3);
}
export const DEFAULT_PIXEL_SIZE = 12;

let nextId = 0;
export function newId(): string {
  nextId += 1;
  return `s${Date.now().toString(36)}${nextId.toString(36)}`;
}

export function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/** Starts a shape where a drag begins. Text and crop are handled by the editor. */
export function beginShape(tool: Tool, at: Point, style: Style, id = newId()): Shape | null {
  const { color, strokeWidth } = style;
  switch (tool) {
    case "arrow":
    case "line":
      return { id, type: tool, color, strokeWidth, points: [at.x, at.y, at.x, at.y] };
    case "freehand":
      return { id, type: "freehand", color, strokeWidth, points: [at.x, at.y] };
    case "highlighter":
      return { id, type: "highlighter", color, strokeWidth: highlighterWidth(strokeWidth), points: [at.x, at.y] };
    case "rect":
    case "ellipse":
      // Optional fields are written only when set, so plain shapes match old sidecars.
      return { id, type: tool, color, strokeWidth, x: at.x, y: at.y, width: 0, height: 0, ...(style.fill ? { fill: true } : {}) };
    case "blur":
      return {
        id,
        type: "blur",
        x: at.x,
        y: at.y,
        width: 0,
        height: 0,
        pixelSize: DEFAULT_PIXEL_SIZE,
        ...(style.blurMode === "blur" ? { mode: "blur" as const } : {}),
      };
    case "spotlight":
      return { id, type: "spotlight", x: at.x, y: at.y, width: 0, height: 0 };
    case "step":
      return { id, type: "step", color, x: at.x, y: at.y, radius: style.stepRadius ?? DEFAULT_STEP_RADIUS };
    default:
      return null;
  }
}

/** The angle a constrained line snaps to: every 45°. */
export const SNAP_ANGLE = Math.PI / 4;

/**
 * Where a line from `from` towards `to` ends when held to `step` angles:
 * `to` projected onto the nearest allowed direction, so the end stays
 * under the pointer along that direction.
 */
export function snapAngle(from: Point, to: Point, step = SNAP_ANGLE): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const length = dx * cos + dy * sin;
  // Rounding off float noise (and -0) keeps straight lines exactly straight.
  const tidy = (value: number) => Math.round(value * 1e6) / 1e6 || 0;
  return { x: tidy(from.x + length * cos), y: tidy(from.y + length * sin) };
}

/** The far corner of a square from `from` towards `to`: the longer side wins. */
export function squareCorner(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) };
}

/**
 * Updates a shape being drawn as the pointer moves to `to`. `constrain`
 * (Shift) holds lines and arrows to 45° steps and boxes to squares; paths
 * are drawn freely.
 */
export function dragShape(shape: Shape, to: Point, constrain = false): Shape {
  switch (shape.type) {
    case "arrow":
    case "line": {
      const from = { x: shape.points[0], y: shape.points[1] };
      const end = constrain ? snapAngle(from, to) : to;
      return { ...shape, points: [from.x, from.y, end.x, end.y] };
    }
    case "freehand":
    case "highlighter":
      return { ...shape, points: [...shape.points, to.x, to.y] };
    case "rect":
    case "ellipse":
    case "blur":
    case "spotlight": {
      const end = constrain ? squareCorner(shape, to) : to;
      return { ...shape, width: end.x - shape.x, height: end.y - shape.y };
    }
    default:
      return shape;
  }
}

/** Ends a drawing: normalises boxes and drops shapes too small to see. */
export function finishShape(shape: Shape): Shape | null {
  switch (shape.type) {
    case "arrow":
    case "line": {
      const [x1, y1, x2, y2] = shape.points;
      return Math.hypot(x2 - x1, y2 - y1) < MIN_SIZE ? null : shape;
    }
    case "freehand":
    case "highlighter":
      // A click leaves a dot.
      return shape.points.length === 2 ? { ...shape, points: [...shape.points, shape.points[0] + 0.5, shape.points[1]] } : shape;
    case "rect":
    case "ellipse":
    case "blur":
    case "spotlight": {
      const rect = normalizeRect(shape);
      return rect.width < MIN_SIZE || rect.height < MIN_SIZE ? null : { ...shape, ...rect };
    }
    default:
      return shape;
  }
}

type Size = { width: number; height: number };

/** The width-over-height ratio a crop aspect holds to: Original is the capture's own; null for Free. */
export function cropAspectRatio(aspect: CropAspect, image: Size | null): number | null {
  if (aspect === "original") return image && image.width > 0 && image.height > 0 ? image.width / image.height : null;
  return CROP_ASPECTS.find((entry) => entry.aspect === aspect)?.ratio ?? null;
}

/** The ratio a crop drag is held to: the picked one, or a square when Shift is held on a Free crop. */
export function cropDragRatio(ratio: number | null, shift: boolean): number | null {
  return ratio ?? (shift ? 1 : null);
}

/**
 * The box a crop drag from `start` to `end` covers, in whole pixels inside
 * the image. With a `ratio` (width over height) the box keeps it from the
 * start corner, its longer side following the pointer, and shrinks to fit
 * when it would leave the image. May be empty; see `cropFromDrag`.
 */
export function cropBox(start: Point, end: Point, image: Size, ratio: number | null = null): Rect {
  if (!ratio) {
    const rect = normalizeRect({ x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y });
    const x = Math.min(image.width, Math.max(0, Math.round(rect.x)));
    const y = Math.min(image.height, Math.max(0, Math.round(rect.y)));
    const right = Math.max(x, Math.min(image.width, Math.round(rect.x + rect.width)));
    const bottom = Math.max(y, Math.min(image.height, Math.round(rect.y + rect.height)));
    return { x, y, width: right - x, height: bottom - y };
  }
  const sx = Math.min(image.width, Math.max(0, Math.round(start.x)));
  const sy = Math.min(image.height, Math.max(0, Math.round(start.y)));
  const dx = end.x - sx;
  const dy = end.y - sy;
  // The room left between the start corner and the image edge the drag heads for.
  const roomX = dx < 0 ? sx : image.width - sx;
  const roomY = dy < 0 ? sy : image.height - sy;
  const exact = Math.min(Math.max(Math.abs(dx), Math.abs(dy) * ratio), roomX, roomY * ratio);
  const width = Math.min(roomX, Math.round(exact));
  const height = Math.min(roomY, Math.round(exact / ratio));
  return { x: dx < 0 ? sx - width : sx, y: dy < 0 ? sy - height : sy, width, height };
}

/**
 * A finished crop drag, clipped to the image, or null for a stray click.
 * With a `ratio` the crop keeps it (see `cropBox`).
 */
export function cropFromDrag(start: Point, end: Point, image: Size, ratio: number | null = null): Rect | null {
  const box = cropBox(start, end, image, ratio);
  return box.width < MIN_SIZE || box.height < MIN_SIZE ? null : box;
}

/** The largest box of `ratio` (width over height) inside `crop`, centred on it, in whole pixels. */
export function fitCropToRatio(crop: Rect, ratio: number): Rect {
  const exact = Math.min(crop.width, crop.height * ratio);
  const width = Math.max(1, Math.min(crop.width, Math.round(exact)));
  const height = Math.max(1, Math.min(crop.height, Math.round(exact / ratio)));
  return {
    x: crop.x + Math.round((crop.width - width) / 2),
    y: crop.y + Math.round((crop.height - height) / 2),
    width,
    height,
  };
}

/** A crop moved so its corner is at `to`, kept whole inside the image and in whole pixels. */
export function moveCrop(crop: Rect, to: Point, image: Size): Rect {
  const clamp = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, Math.round(value)));
  return { ...crop, x: clamp(to.x, image.width - crop.width), y: clamp(to.y, image.height - crop.height) };
}

/**
 * Where a crop resized from `from` to the handle box `box` ends up: the
 * edges that stayed put hold still, the box is clipped to the image, and
 * with a `ratio` it keeps that ratio, shrinking to fit. A resize that would
 * leave the crop smaller than `MIN_SIZE` keeps `from`.
 */
export function resizeCrop(from: Rect, box: Rect, image: Size, ratio: number | null = null): Rect {
  const next = normalizeRect(box);
  const right = next.x + next.width;
  const bottom = next.y + next.height;
  // Whichever edge moved less is the one held still.
  const leftHeld = Math.abs(next.x - from.x) <= Math.abs(right - (from.x + from.width));
  const topHeld = Math.abs(next.y - from.y) <= Math.abs(bottom - (from.y + from.height));
  const start = { x: leftHeld ? next.x : right, y: topHeld ? next.y : bottom };
  const end = { x: leftHeld ? right : next.x, y: topHeld ? bottom : next.y };
  return cropFromDrag(start, end, image, ratio) ?? from;
}

/** Crop edges snap to a line within this many screen pixels (divide by the view scale for capture pixels). */
export const CROP_SNAP_PX = 6;

/** Lines a crop snaps to, in capture pixels: `x` vertical, `y` horizontal. See `findEdges`. */
export interface SnapLines {
  x: number[];
  y: number[];
}

/** The sides of a crop that are moving. Both sides of a pair moving moves the crop along that axis. */
export interface CropSides {
  left: boolean;
  right: boolean;
  top: boolean;
  bottom: boolean;
}

/** Every side moving: the crop is being moved whole. */
export const ALL_SIDES: CropSides = { left: true, right: true, top: true, bottom: true };

/** The sides a crop resize handle moves, from its Konva anchor name ("top-left", "middle-right"…). */
export function anchorSides(anchor: string): CropSides {
  return { left: anchor.includes("left"), right: anchor.includes("right"), top: anchor.includes("top"), bottom: anchor.includes("bottom") };
}

/**
 * The handle box `box` with the sides that are not `moving` put back where
 * they were in `from`. Konva scales from the centre while ⌥/Alt is held;
 * this keeps the far side still regardless.
 */
export function holdCropSides(from: Rect, box: Rect, moving: CropSides): Rect {
  const next = normalizeRect(box);
  const left = moving.left ? next.x : from.x;
  const right = moving.right ? next.x + next.width : from.x + from.width;
  const top = moving.top ? next.y : from.y;
  const bottom = moving.bottom ? next.y + next.height : from.y + from.height;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The line in `lines` nearest `value`, if one is within `threshold`; null otherwise. */
export function nearestLine(value: number, lines: number[], threshold: number): number | null {
  let best: number | null = null;
  for (const line of lines) {
    const distance = Math.abs(line - value);
    if (distance <= threshold && (best === null || distance < Math.abs(best - value))) best = line;
  }
  return best;
}

/** The lines along one axis a crop snaps to: the image's two borders plus those found in it. */
function axisLines(found: number[], limit: number): number[] {
  return [0, ...found.filter((line) => line > 0 && line < limit), limit];
}

/**
 * One axis of a free snap: `start` and `size` along it, with either side,
 * or both (a move), drawn to the nearest line. A snap that would leave the
 * image or the crop smaller than `MIN_SIZE` is dropped.
 */
function snapSpan(start: number, size: number, moveStart: boolean, moveEnd: boolean, lines: number[], threshold: number, limit: number): [number, number] {
  const end = start + size;
  if (moveStart && moveEnd) {
    const toStart = nearestLine(start, lines, threshold);
    const toEnd = nearestLine(end, lines, threshold);
    const shifts = [toStart === null ? null : toStart - start, toEnd === null ? null : toEnd - end]
      .filter((shift): shift is number => shift !== null && start + shift >= 0 && end + shift <= limit)
      .sort((a, b) => Math.abs(a) - Math.abs(b));
    return shifts.length ? [start + shifts[0], size] : [start, size];
  }
  if (moveStart) {
    const line = nearestLine(start, lines, threshold);
    if (line !== null && end - line >= MIN_SIZE) return [line, end - line];
  } else if (moveEnd) {
    const line = nearestLine(end, lines, threshold);
    if (line !== null && line - start >= MIN_SIZE) return [start, line - start];
  }
  return [start, size];
}

/**
 * The crop with its `moving` sides snapped to the nearest of `lines` or
 * the image borders within `threshold` capture pixels. A crop being moved
 * (both sides of an axis) shifts to whichever side is nearer a line. With a
 * `ratio` (width over height), only the dragged side snaps and the other
 * follows from the ratio; at a corner the nearer snap wins, and a snap that
 * would leave the image is dropped. Without a snap the crop is unchanged.
 */
export function snapCropEdges(crop: Rect, moving: CropSides, lines: SnapLines, threshold: number, image: Size, ratio: number | null = null): Rect {
  const xs = axisLines(lines.x, image.width);
  const ys = axisLines(lines.y, image.height);
  const moveX = moving.left && moving.right;
  const moveY = moving.top && moving.bottom;
  if (!ratio || moveX || moveY) {
    const [x, width] = snapSpan(crop.x, crop.width, moving.left, moving.right, xs, threshold, image.width);
    const [y, height] = snapSpan(crop.y, crop.height, moving.top, moving.bottom, ys, threshold, image.height);
    return { x, y, width, height };
  }
  const left = crop.x;
  const right = crop.x + crop.width;
  const top = crop.y;
  const bottom = crop.y + crop.height;
  // The corner (or side) opposite the dragged one holds still.
  const place = (width: number, height: number): Rect => ({
    x: moving.left ? right - width : left,
    y: moving.top ? bottom - height : top,
    width,
    height,
  });
  const inside = (rect: Rect) =>
    rect.width >= MIN_SIZE && rect.height >= MIN_SIZE && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= image.width && rect.y + rect.height <= image.height;
  const candidates: { rect: Rect; distance: number }[] = [];
  if (moving.left || moving.right) {
    const edge = moving.left ? left : right;
    const line = nearestLine(edge, xs, threshold);
    if (line !== null) {
      const width = moving.left ? right - line : line - left;
      candidates.push({ rect: place(width, Math.round(width / ratio)), distance: Math.abs(line - edge) });
    }
  }
  if (moving.top || moving.bottom) {
    const edge = moving.top ? top : bottom;
    const line = nearestLine(edge, ys, threshold);
    if (line !== null) {
      const height = moving.top ? bottom - line : line - top;
      candidates.push({ rect: place(Math.round(height * ratio), height), distance: Math.abs(line - edge) });
    }
  }
  const best = candidates.filter((candidate) => inside(candidate.rect)).sort((a, b) => a.distance - b.distance)[0];
  return best ? best.rect : crop;
}

/**
 * A crop drag from `start` to `end` (see `cropBox`) snapped to `lines` and
 * the image borders within `threshold`: the start corner snaps, then the
 * dragged sides (see `snapCropEdges`). A drag too small to be a crop is
 * left as it is, so a stray click near a corner stays a stray click.
 */
export function snapCropDrag(start: Point, end: Point, image: Size, ratio: number | null, lines: SnapLines, threshold: number): Rect {
  const raw = cropBox(start, end, image, ratio);
  if (raw.width < MIN_SIZE || raw.height < MIN_SIZE) return raw;
  const from = {
    x: nearestLine(start.x, axisLines(lines.x, image.width), threshold) ?? start.x,
    y: nearestLine(start.y, axisLines(lines.y, image.height), threshold) ?? start.y,
  };
  const box = cropBox(from, end, image, ratio);
  const sides = { left: end.x < from.x, right: end.x >= from.x, top: end.y < from.y, bottom: end.y >= from.y };
  return snapCropEdges(box, sides, lines, threshold, image, ratio);
}

/**
 * A crop drawn on show (display space) back in capture pixels, where
 * `Annotations.crop` lives: its two corners mapped with `toCapture` and
 * normalised. The inverse of `orientRect`. `size` is the capture's own size.
 */
export function cropToCapture(shown: Rect, size: Size, o: Orientation): Rect {
  const a = toCapture({ x: shown.x, y: shown.y }, size, o);
  const b = toCapture({ x: shown.x + shown.width, y: shown.y + shown.height }, size, o);
  const x = Math.round(Math.min(a.x, b.x));
  const y = Math.round(Math.min(a.y, b.y));
  return { x, y, width: Math.round(Math.max(a.x, b.x)) - x, height: Math.round(Math.max(a.y, b.y)) - y };
}

/**
 * Applies a Konva drag or resize. `x`/`y` are the node's new position and
 * `scaleX`/`scaleY` its scale; nodes are drawn at the shape's position
 * (point shapes at 0, 0), so both reduce to one mapping.
 */
export interface NodeTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

/** Transformer anchors at the corners only. */
export const CORNER_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"];
/** Every Transformer anchor (Konva's default). */
export const ALL_ANCHORS = [...CORNER_ANCHORS, "top-center", "middle-left", "middle-right", "bottom-center"];

/**
 * The resize handles a shape offers. Text and step badges have a single size
 * (font size, radius), so a side handle could only stretch one axis; they
 * resize from the corners, keeping their ratio.
 */
export function anchorsFor(shape: Shape | null): string[] {
  return shape?.type === "text" || shape?.type === "step" ? CORNER_ANCHORS : ALL_ANCHORS;
}

/**
 * One scale factor for a shape with a single size: whichever axis changed
 * more, so a stretch along either axis resizes it.
 */
function uniformScale(t: NodeTransform): number {
  const x = Math.abs(t.scaleX) || 1;
  const y = Math.abs(t.scaleY) || 1;
  return Math.abs(Math.log(x)) >= Math.abs(Math.log(y)) ? x : y;
}

export function transformShape(shape: Shape, t: NodeTransform): Shape {
  switch (shape.type) {
    case "arrow":
    case "line": {
      const points = shape.points.map((value, i) => (i % 2 === 0 ? t.x + value * t.scaleX : t.y + value * t.scaleY));
      if (!shape.control) return { ...shape, points };
      const [cx, cy] = shape.control;
      return { ...shape, points, control: [t.x + cx * t.scaleX, t.y + cy * t.scaleY] };
    }
    case "freehand":
    case "highlighter":
      return {
        ...shape,
        points: shape.points.map((value, i) => (i % 2 === 0 ? t.x + value * t.scaleX : t.y + value * t.scaleY)),
      };
    case "rect":
    case "ellipse":
    case "blur":
    case "spotlight":
      return {
        ...shape,
        ...normalizeRect({ x: t.x, y: t.y, width: shape.width * t.scaleX, height: shape.height * t.scaleY }),
      };
    case "text":
      return { ...shape, x: t.x, y: t.y, fontSize: Math.max(6, shape.fontSize * uniformScale(t)) };
    case "step":
      return { ...shape, x: t.x, y: t.y, radius: Math.max(6, shape.radius * uniformScale(t)) };
  }
}

/* Curved arrows and lines: a quadratic curve from the start, bent towards `control`, to the end. */

/** How close to the straight line, in screen pixels, a bend handle snaps the line straight. */
export const STRAIGHTEN_SNAP = 6;

/** Arrows and lines are edited with their own bend and end handles instead of the box Transformer. */
export function hasLineHandles(shape: Shape | null): shape is LineShape {
  return shape?.type === "arrow" || shape?.type === "line";
}

const lineEnds = (shape: LineShape): [Point, Point] => [
  { x: shape.points[0], y: shape.points[1] },
  { x: shape.points[2], y: shape.points[3] },
];

/** The point halfway along the curve (t = 0.5), where its bend handle sits: the chord's midpoint when straight. */
export function curveMidpoint(shape: LineShape): Point {
  const [start, end] = lineEnds(shape);
  const chord = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  if (!shape.control) return chord;
  const [cx, cy] = shape.control;
  return { x: chord.x / 2 + cx / 2, y: chord.y / 2 + cy / 2 };
}

/** The control point that puts the curve's midpoint at `handle`: C = 2H − (P0 + P2) / 2. */
export function controlFromHandle(start: Point, end: Point, handle: Point): [number, number] {
  return [2 * handle.x - (start.x + end.x) / 2, 2 * handle.y - (start.y + end.y) / 2];
}

/**
 * Bends a line so its midpoint passes through `handle`. Within `snap`
 * (capture pixels) of the straight line's midpoint, the line goes straight
 * again and loses its control point.
 */
export function bendLine(shape: LineShape, handle: Point, snap: number): LineShape {
  const [start, end] = lineEnds(shape);
  const chord = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  if (Math.hypot(handle.x - chord.x, handle.y - chord.y) <= snap) {
    const straight = { ...shape };
    delete straight.control;
    return straight;
  }
  return { ...shape, control: controlFromHandle(start, end, handle) };
}

/**
 * Moves one end of a line (0 the start, 1 the end) to `to`, keeping the
 * bend: the curve's midpoint keeps its place relative to the chord, so the
 * curve stretches with the line rather than flipping.
 */
export function moveLineEnd(shape: LineShape, end: 0 | 1, to: Point): LineShape {
  const points = end === 0 ? [to.x, to.y, shape.points[2], shape.points[3]] : [shape.points[0], shape.points[1], to.x, to.y];
  if (!shape.control) return { ...shape, points };
  const [oldStart, oldEnd] = lineEnds(shape);
  const moved = { ...shape, points };
  const [newStart, newEnd] = lineEnds(moved);
  // The bend as an offset in the chord's own frame (along, across), carried over to the new chord.
  const mid = curveMidpoint(shape);
  const oldChord = { x: oldEnd.x - oldStart.x, y: oldEnd.y - oldStart.y };
  const newChord = { x: newEnd.x - newStart.x, y: newEnd.y - newStart.y };
  const oldLength = Math.hypot(oldChord.x, oldChord.y);
  const newLength = Math.hypot(newChord.x, newChord.y);
  if (oldLength === 0 || newLength === 0) return moved;
  const rel = { x: mid.x - (oldStart.x + oldEnd.x) / 2, y: mid.y - (oldStart.y + oldEnd.y) / 2 };
  const along = (rel.x * oldChord.x + rel.y * oldChord.y) / oldLength / oldLength;
  const across = (rel.y * oldChord.x - rel.x * oldChord.y) / oldLength / oldLength;
  const handle = {
    x: (newStart.x + newEnd.x) / 2 + along * newChord.x - across * newChord.y,
    y: (newStart.y + newEnd.y) / 2 + along * newChord.y + across * newChord.x,
  };
  return { ...moved, control: controlFromHandle(newStart, newEnd, handle) };
}

/**
 * The points Konva draws a line with: the two ends when straight, or the
 * quadratic as one cubic bezier segment (P0, P0 + 2/3(C − P0), P2 + 2/3(C − P2), P2)
 * when curved. Konva aims an arrowhead from the last control point to the
 * end, which is the curve's end tangent.
 */
export function curvePoints(shape: LineShape): number[] {
  if (!shape.control) return shape.points;
  const [x0, y0, x2, y2] = shape.points;
  const [cx, cy] = shape.control;
  const third = 2 / 3;
  return [x0, y0, x0 + third * (cx - x0), y0 + third * (cy - y0), x2 + third * (cx - x2), y2 + third * (cy - y2), x2, y2];
}

/** Moves a shape by dx, dy. */
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  if ("points" in shape) return transformShape(shape, { x: dx, y: dy, scaleX: 1, scaleY: 1 });
  return transformShape(shape, { x: shape.x + dx, y: shape.y + dy, scaleX: 1, scaleY: 1 });
}

/** Step badge numbers: 1, 2, 3... in the order the steps were added. */
export function stepNumbers(shapes: Shape[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const shape of shapes) {
    if (shape.type === "step") numbers.set(shape.id, numbers.size + 1);
  }
  return numbers;
}

/**
 * Applies the parts of `style` a shape has: colour (not blur or spotlight),
 * stroke width on stroked shapes (widened for the highlighter), font size
 * on text, radius on steps, fill on boxes, background on text and the blur
 * mode. A style that changes nothing returns the same shape.
 */
export function restyleShape(shape: Shape, style: Partial<Style>): Shape {
  if (shape.type === "spotlight") return shape;
  if (shape.type === "blur") {
    if (!style.blurMode || style.blurMode === (shape.mode ?? "pixelate")) return shape;
    return { ...shape, mode: style.blurMode };
  }
  let next: Shape = style.color ? { ...shape, color: style.color } : shape;
  if (style.strokeWidth && "strokeWidth" in next) {
    const strokeWidth = next.type === "highlighter" ? highlighterWidth(style.strokeWidth) : style.strokeWidth;
    if (strokeWidth !== next.strokeWidth) next = { ...next, strokeWidth };
  }
  if (style.fontSize && next.type === "text" && style.fontSize !== next.fontSize) {
    next = { ...next, fontSize: style.fontSize };
  }
  if (style.stepRadius && next.type === "step" && style.stepRadius !== next.radius) {
    next = { ...next, radius: style.stepRadius };
  }
  if (style.fill !== undefined && (next.type === "rect" || next.type === "ellipse")) {
    next = { ...next, fill: style.fill };
  }
  if (style.background !== undefined && next.type === "text") {
    next = { ...next, background: style.background };
  }
  return next;
}

/** A copy with a new id, offset so it does not hide the original. */
export function duplicateShape(shape: Shape, id = newId(), offset = DUPLICATE_OFFSET): Shape {
  return { ...moveShape(shape, offset, offset), id };
}

/** The move an arrow key makes: 1px, or 10px with Shift. Null for any other key. */
export function nudgeDelta(key: string, shift: boolean): Point | null {
  const step = shift ? 10 : 1;
  switch (key) {
    case "ArrowLeft":
      return { x: -step, y: 0 };
    case "ArrowRight":
      return { x: step, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -step };
    case "ArrowDown":
      return { x: 0, y: step };
    default:
      return null;
  }
}

/** How long a tool key must be held to count as a hold rather than a tap. */
export const HOLD_MS = 250;

/**
 * Whether letting go of a tool key brings back the tool from before it: a
 * key held past `HOLD_MS`, or held while something was drawn, was a hold
 * ("use once"); a quick tap keeps the new tool.
 */
export function releaseRestores(heldMs: number, used: boolean): boolean {
  return used || heldMs >= HOLD_MS;
}

/**
 * The tool a modified drag draws over the `active` tool: ⌘ (Ctrl
 * elsewhere) a rectangle, ⌥ (Alt) an arrow. Null for a plain drag, and for
 * ⌥ with the Crop tool, where it crops without snapping instead.
 */
export function modifierTool(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }, active?: Tool): Tool | null {
  if (event.ctrlKey || event.metaKey) return "rect";
  if (event.altKey && active !== "crop") return "arrow";
  return null;
}

/** The swatch a number key picks: 1 is the first colour. Null for any other key. */
export function colorForKey(key: string): string | null {
  if (!/^[1-9]$/.test(key)) return null;
  return COLORS[Number(key) - 1] ?? null;
}

/**
 * The next width down (-1) or up (1) `presets` (the stroke widths unless
 * given), stopping at the ends.
 */
export function stepStrokeWidth(current: number, direction: -1 | 1, presets: number[] = STROKE_WIDTHS): number {
  if (direction > 0) return presets.find((width) => width > current) ?? current;
  return [...presets].reverse().find((width) => width < current) ?? current;
}

/**
 * The area to dim around spotlights: `bounds` minus every hole, as
 * rectangles that do not overlap (so their shade never doubles up). Empty
 * when no hole lies inside the bounds, so a capture without spotlights is
 * not dimmed.
 */
export function spotlightDim(bounds: Rect, holes: Rect[]): Rect[] {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const lit = holes
    .map(normalizeRect)
    .map((hole) => {
      const x = Math.max(bounds.x, hole.x);
      const y = Math.max(bounds.y, hole.y);
      return { x, y, width: Math.min(right, hole.x + hole.width) - x, height: Math.min(bottom, hole.y + hole.height) - y };
    })
    .filter((hole) => hole.width > 0 && hole.height > 0);
  if (lit.length === 0) return [];
  // Cut the bounds along every hole edge; each cell is then wholly lit or wholly dim.
  const cuts = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);
  const xs = cuts([bounds.x, right, ...lit.flatMap((hole) => [hole.x, hole.x + hole.width])]);
  const ys = cuts([bounds.y, bottom, ...lit.flatMap((hole) => [hole.y, hole.y + hole.height])]);
  const dim: Rect[] = [];
  for (let row = 0; row < ys.length - 1; row += 1) {
    const cy = (ys[row] + ys[row + 1]) / 2;
    let run: Rect | null = null;
    for (let col = 0; col < xs.length - 1; col += 1) {
      const cx = (xs[col] + xs[col + 1]) / 2;
      if (lit.some((hole) => cx > hole.x && cx < hole.x + hole.width && cy > hole.y && cy < hole.y + hole.height)) {
        run = null;
      } else if (run) {
        // Join neighbouring dim cells in a row.
        run.width = xs[col + 1] - run.x;
      } else {
        run = { x: xs[col], y: ys[row], width: xs[col + 1] - xs[col], height: ys[row + 1] - ys[row] };
        dim.push(run);
      }
    }
  }
  return dim;
}

/** `#rgb` or `#rrggbb` as 0-255 channels; null for anything else. */
function hexChannels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
}

/** A hex colour at `alpha`; a colour that is not hex is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const channels = hexChannels(color);
  return channels ? `rgba(${channels.join(", ")}, ${alpha})` : color;
}

/** White or near-black, whichever reads better on `color`. */
export function contrastColor(color: string): string {
  const channels = hexChannels(color);
  if (!channels) return "#ffffff";
  const [r, g, b] = channels;
  // Perceived brightness (ITU-R BT.601).
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? "#1f2328" : "#ffffff";
}

export function addShape(doc: Annotations, shape: Shape): Annotations {
  return { ...doc, shapes: [...doc.shapes, shape] };
}

export function replaceShape(doc: Annotations, shape: Shape): Annotations {
  return { ...doc, shapes: doc.shapes.map((old) => (old.id === shape.id ? shape : old)) };
}

export function deleteShape(doc: Annotations, id: string): Annotations {
  return { ...doc, shapes: doc.shapes.filter((shape) => shape.id !== id) };
}

/* The right-click tool wheel (ToolWheel.tsx). */

/** Distance from the wheel's centre to the centre of each tool button, in CSS pixels. */
export const WHEEL_RADIUS = 88;
/** How far the wheel reaches past its radius (half a button plus a margin). */
export const WHEEL_REACH = WHEEL_RADIUS + 28;

/** Where the `index`th of `count` buttons sits around the ring, from the top, clockwise. */
export function ringPosition(index: number, count: number, radius = WHEEL_RADIUS): Point {
  const angle = -Math.PI / 2 + (index * 2 * Math.PI) / count;
  return { x: Math.round(radius * Math.cos(angle)), y: Math.round(radius * Math.sin(angle)) };
}

/** Keeps a wheel opened at `at` inside a canvas of `size`, so no tool lands off screen. */
export function clampWheel(at: Point, size: { width: number; height: number }): Point {
  const clamp = (value: number, max: number) => Math.min(Math.max(value, WHEEL_REACH), Math.max(WHEEL_REACH, max - WHEEL_REACH));
  return { x: clamp(at.x, size.width), y: clamp(at.y, size.height) };
}
