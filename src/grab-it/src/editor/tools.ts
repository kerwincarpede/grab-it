import { arrowStyle } from "./arrowStyles";
import {
  COLORS,
  CROP_ASPECTS,
  DEFAULT_STAMP_SIZE,
  DEFAULT_STEP_RADIUS,
  nearestPreset,
  STROKE_WIDTHS,
  type Annotations,
  type CropAspect,
  type ImageShape,
  type LineShape,
  type PathShape,
  type Point,
  type Rect,
  type Shape,
  type StampShape,
  type Style,
  type TextLook,
  type TextShape,
  type Tool,
} from "./model";
import { boundsEdges, toCapture, type Bounds, type Orientation } from "./orient";
import { DEFAULT_STAMP, KEYCAP, stampPick, takesColor, type StampPick } from "./stamps";
import { BAND_MAX_ANGLE } from "./textBand";

/** How far a duplicate lands from its original, in capture pixels. */
export const DUPLICATE_OFFSET = 12;
/** Shapes smaller than this many pixels are treated as a stray click. */
export const MIN_SIZE = 3;
export const HIGHLIGHTER_WIDTH = 18;
/** The highlighter is drawn wider than the width picked: 3 × width + 6 px (1 → 9 px, 4 → 18 px, 24 → 78 px). */
export function highlighterWidth(strokeWidth: number): number {
  return strokeWidth * 3 + 6;
}
/**
 * The Width preset nearest a highlight's drawn thickness: `strokeWidth - band`
 * for a stroke fitted to text, else `(strokeWidth - 6) / 3`.
 */
export function highlighterPreset(shape: Pick<PathShape, "strokeWidth" | "band">, presets: number[] = STROKE_WIDTHS): number {
  const raw = shape.band !== undefined ? shape.strokeWidth - shape.band : (shape.strokeWidth - 6) / 3;
  return presets[nearestPreset(presets, raw)];
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
      return {
        id, type: tool, color, strokeWidth, points: [at.x, at.y, at.x, at.y],
        ...(tool === "arrow" && style.arrowStyle && style.arrowStyle !== "classic" ? { arrowStyle: style.arrowStyle } : {}),
      };
    case "freehand":
      return { id, type: "freehand", color, strokeWidth, points: [at.x, at.y] };
    case "highlighter":
      return { id, type: "highlighter", color, strokeWidth: highlighterWidth(strokeWidth), points: [at.x, at.y] };
    case "rect":
    case "ellipse":
      // Optional fields are written only when set, so plain shapes match old sidecars.
      return { id, type: tool, color, strokeWidth, x: at.x, y: at.y, width: 0, height: 0, ...(style.fill ? { fill: true } : {}) };
    case "magnify":
      return { id, type: "magnify", color, strokeWidth, x: at.x, y: at.y, width: 0, height: 0,
        spot: [at.x, at.y], zoom: style.zoom ?? 2,
        ...(style.lens === "square" ? { lens: "square" as const } : {}),
        ...(style.lensLine ? { line: true } : {}) };
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
    case "stamp": {
      // A keycap with no label is placed by the editor once its label is typed.
      const pick = pickedStamp(style);
      return needsLabel(pick) ? null : placeStamp(pick, at, style, id);
    }
    default:
      return null;
  }
}

/** The stamp the Stamp tool places with `style`: the picked one, else `DEFAULT_STAMP`. */
export function pickedStamp(style: Pick<Style, "stamp">): StampPick {
  return stampPick(style.stamp) ?? { name: DEFAULT_STAMP };
}

/** A keycap picked without a label: placing it asks for one. */
export function needsLabel(pick: StampPick): boolean {
  return pick.name === KEYCAP.name && !pick.label;
}

/**
 * A stamp centred on `at`, at the style's stamp size. Only stamps that take
 * a colour get one, and only a keycap gets a label; optional fields are
 * written only when set.
 */
export function placeStamp(pick: StampPick, at: Point, style: Pick<Style, "color" | "stampSize">, id = newId()): StampShape {
  return {
    id,
    type: "stamp",
    name: pick.name,
    x: at.x,
    y: at.y,
    size: style.stampSize ?? DEFAULT_STAMP_SIZE,
    ...(takesColor(pick.name) ? { color: style.color } : {}),
    ...(pick.name === KEYCAP.name && pick.label ? { label: pick.label } : {}),
  };
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
    case "magnify":
    case "rect":
    case "ellipse":
    case "blur":
    case "spotlight": {
      const end = constrain || shape.type === "magnify" ? squareCorner(shape, to) : to;
      const width = end.x - shape.x;
      const height = end.y - shape.y;
      return { ...shape, width, height,
        ...(shape.type === "magnify" ? { spot: [shape.x + width / 2, shape.y + height / 2] as [number, number] } : {}) };
    }
    default:
      return shape;
  }
}

/** How many times a finished path is smoothed (see `smoothPath`). */
export const SMOOTH_PASSES = 2;
/** The least a finished path's points may stray from it when simplified, in capture pixels. */
export const SIMPLIFY_TOLERANCE = 1;

/**
 * A path's points with the jitter of a hand evened out: each point but the
 * two ends moves towards its neighbours (weights 1, 2, 1), `passes` times.
 */
export function smoothPath(points: number[], passes = SMOOTH_PASSES): number[] {
  let path = points;
  const count = points.length / 2;
  for (let pass = 0; pass < passes && count > 2; pass += 1) {
    const next = [...path];
    for (let i = 1; i < count - 1; i += 1) {
      for (const axis of [0, 1]) {
        next[i * 2 + axis] = (path[(i - 1) * 2 + axis] + 2 * path[i * 2 + axis] + path[(i + 1) * 2 + axis]) / 4;
      }
    }
    path = next;
  }
  return path;
}

/** How far `p` lies from the segment `a`–`b`. */
function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * A path with the points it can do without dropped (Ramer–Douglas–Peucker):
 * every point dropped lies within `tolerance` of what is kept, and both
 * ends are always kept.
 */
export function simplifyPath(points: number[], tolerance: number): number[] {
  const count = points.length / 2;
  if (count <= 2) return points;
  const at = (i: number): Point => ({ x: points[i * 2], y: points[i * 2 + 1] });
  const keep = new Array<boolean>(count).fill(false);
  keep[0] = true;
  keep[count - 1] = true;
  // Spans still to split, as [first, last] point indices; a stack rather than recursion keeps long strokes safe.
  const spans: [number, number][] = [[0, count - 1]];
  while (spans.length) {
    const [first, last] = spans.pop()!;
    let farthest = -1;
    let distance = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const d = segmentDistance(at(i), at(first), at(last));
      if (d > distance) {
        distance = d;
        farthest = i;
      }
    }
    if (farthest < 0) continue;
    keep[farthest] = true;
    spans.push([first, farthest], [farthest, last]);
  }
  return points.filter((_, i) => keep[Math.floor(i / 2)]);
}

/**
 * A finished freehand or highlighter path: smoothed, then simplified. A
 * thicker stroke hides more, so it may lose points that stray further (a
 * quarter of its width). Konva's tension draws curves through what is left.
 */
export function tidyPath(points: number[], strokeWidth: number): number[] {
  return simplifyPath(smoothPath(points), Math.max(SIMPLIFY_TOLERANCE, strokeWidth / 4));
}

/** Shortest drag (in capture pixels) that a highlighter without text straightens. */
export const STRAIGHTEN_MIN_LENGTH = 24;
/** Minimum chord distance (in capture pixels) for straightening a near-level highlighter drag. */
export const STRAIGHTEN_TOLERANCE = 4;

/**
 * Straightens a near-level highlighter path that had no text under it:
 * drags of at least `STRAIGHTEN_MIN_LENGTH` px within `BAND_MAX_ANGLE` of
 * horizontal whose points all lie within `max(STRAIGHTEN_TOLERANCE, strokeWidth / 4)`
 * of the chord become a level bar from min to max x at the mean y.
 */
export function straightenPath(points: number[], strokeWidth: number): number[] {
  const count = Math.floor(points.length / 2);
  if (count < 2) return points;
  const start: Point = { x: points[0], y: points[1] };
  const end: Point = { x: points[(count - 1) * 2], y: points[(count - 1) * 2 + 1] };
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < STRAIGHTEN_MIN_LENGTH) return points;
  if (Math.atan2(Math.abs(dy), Math.abs(dx)) > BAND_MAX_ANGLE) return points;
  const limit = Math.max(STRAIGHTEN_TOLERANCE, strokeWidth / 4);
  let minX = start.x;
  let maxX = start.x;
  let sumY = 0;
  for (let i = 0; i < count; i += 1) {
    const p: Point = { x: points[i * 2], y: points[i * 2 + 1] };
    if (segmentDistance(p, start, end) > limit) return points;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    sumY += p.y;
  }
  const meanY = sumY / count;
  return [minX, meanY, maxX, meanY];
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
      if (shape.points.length === 2) return { ...shape, points: [...shape.points, shape.points[0] + 0.5, shape.points[1]] };
      return { ...shape, points: tidyPath(shape.points, shape.strokeWidth) };
    case "magnify":
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
 * `bounds` (the capture, or the canvas grown by added images). With a
 * `ratio` (width over height) the box keeps it from the start corner, its
 * longer side following the pointer, and shrinks to fit when it would leave
 * the bounds. May be empty; see `cropFromDrag`.
 */
export function cropBox(start: Point, end: Point, bounds: Bounds, ratio: number | null = null): Rect {
  const { left, top, right: maxX, bottom: maxY } = boundsEdges(bounds);
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
  if (!ratio) {
    const rect = normalizeRect({ x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y });
    const x = clamp(rect.x, left, maxX);
    const y = clamp(rect.y, top, maxY);
    const right = clamp(rect.x + rect.width, x, maxX);
    const bottom = clamp(rect.y + rect.height, y, maxY);
    return { x, y, width: right - x, height: bottom - y };
  }
  const sx = clamp(start.x, left, maxX);
  const sy = clamp(start.y, top, maxY);
  const dx = end.x - sx;
  const dy = end.y - sy;
  // The room left between the start corner and the edge the drag heads for.
  const roomX = dx < 0 ? sx - left : maxX - sx;
  const roomY = dy < 0 ? sy - top : maxY - sy;
  const exact = Math.min(Math.max(Math.abs(dx), Math.abs(dy) * ratio), roomX, roomY * ratio);
  const width = Math.min(roomX, Math.round(exact));
  const height = Math.min(roomY, Math.round(exact / ratio));
  return { x: dx < 0 ? sx - width : sx, y: dy < 0 ? sy - height : sy, width, height };
}

/**
 * A finished crop drag, clipped to `bounds`, or null for a stray click.
 * With a `ratio` the crop keeps it (see `cropBox`).
 */
export function cropFromDrag(start: Point, end: Point, bounds: Bounds, ratio: number | null = null): Rect | null {
  const box = cropBox(start, end, bounds, ratio);
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

/** A crop moved so its corner is at `to`, kept whole inside `bounds` and in whole pixels. */
export function moveCrop(crop: Rect, to: Point, bounds: Bounds): Rect {
  const { left, top, right, bottom } = boundsEdges(bounds);
  const clamp = (value: number, min: number, max: number) => Math.min(Math.max(min, max), Math.max(min, Math.round(value)));
  return { ...crop, x: clamp(to.x, left, right - crop.width), y: clamp(to.y, top, bottom - crop.height) };
}

/**
 * Where a crop resized from `from` to the handle box `box` ends up: the
 * edges that stayed put hold still, the box is clipped to `bounds`, and
 * with a `ratio` it keeps that ratio, shrinking to fit. A resize that would
 * leave the crop smaller than `MIN_SIZE` keeps `from`.
 */
export function resizeCrop(from: Rect, box: Rect, bounds: Bounds, ratio: number | null = null): Rect {
  const next = normalizeRect(box);
  const right = next.x + next.width;
  const bottom = next.y + next.height;
  // Whichever edge moved less is the one held still.
  const leftHeld = Math.abs(next.x - from.x) <= Math.abs(right - (from.x + from.width));
  const topHeld = Math.abs(next.y - from.y) <= Math.abs(bottom - (from.y + from.height));
  const start = { x: leftHeld ? next.x : right, y: topHeld ? next.y : bottom };
  const end = { x: leftHeld ? right : next.x, y: topHeld ? bottom : next.y };
  return cropFromDrag(start, end, bounds, ratio) ?? from;
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

/** The lines along one axis a crop snaps to: the bounds' two edges plus those found between them. */
function axisLines(found: number[], min: number, max: number): number[] {
  return [min, ...found.filter((line) => line > min && line < max), max];
}

/**
 * One axis of a free snap: `start` and `size` along it, with either side,
 * or both (a move), drawn to the nearest line. A snap that would leave the
 * bounds (`min` to `max`) or the crop smaller than `MIN_SIZE` is dropped.
 */
function snapSpan(
  start: number,
  size: number,
  moveStart: boolean,
  moveEnd: boolean,
  lines: number[],
  threshold: number,
  min: number,
  max: number,
): [number, number] {
  const end = start + size;
  if (moveStart && moveEnd) {
    const toStart = nearestLine(start, lines, threshold);
    const toEnd = nearestLine(end, lines, threshold);
    const shifts = [toStart === null ? null : toStart - start, toEnd === null ? null : toEnd - end]
      .filter((shift): shift is number => shift !== null && start + shift >= min && end + shift <= max)
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
 * the edges of `bounds` within `threshold` pixels. A crop being moved
 * (both sides of an axis) shifts to whichever side is nearer a line. With a
 * `ratio` (width over height), only the dragged side snaps and the other
 * follows from the ratio; at a corner the nearer snap wins, and a snap that
 * would leave the bounds is dropped. Without a snap the crop is unchanged.
 */
export function snapCropEdges(crop: Rect, moving: CropSides, lines: SnapLines, threshold: number, bounds: Bounds, ratio: number | null = null): Rect {
  const edges = boundsEdges(bounds);
  const xs = axisLines(lines.x, edges.left, edges.right);
  const ys = axisLines(lines.y, edges.top, edges.bottom);
  const moveX = moving.left && moving.right;
  const moveY = moving.top && moving.bottom;
  if (!ratio || moveX || moveY) {
    const [x, width] = snapSpan(crop.x, crop.width, moving.left, moving.right, xs, threshold, edges.left, edges.right);
    const [y, height] = snapSpan(crop.y, crop.height, moving.top, moving.bottom, ys, threshold, edges.top, edges.bottom);
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
    rect.width >= MIN_SIZE &&
    rect.height >= MIN_SIZE &&
    rect.x >= edges.left &&
    rect.y >= edges.top &&
    rect.x + rect.width <= edges.right &&
    rect.y + rect.height <= edges.bottom;
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
 * the edges of `bounds` within `threshold`: the start corner snaps, then the
 * dragged sides (see `snapCropEdges`). A drag too small to be a crop is
 * left as it is, so a stray click near a corner stays a stray click.
 */
export function snapCropDrag(start: Point, end: Point, bounds: Bounds, ratio: number | null, lines: SnapLines, threshold: number): Rect {
  const raw = cropBox(start, end, bounds, ratio);
  if (raw.width < MIN_SIZE || raw.height < MIN_SIZE) return raw;
  const edges = boundsEdges(bounds);
  const from = {
    x: nearestLine(start.x, axisLines(lines.x, edges.left, edges.right), threshold) ?? start.x,
    y: nearestLine(start.y, axisLines(lines.y, edges.top, edges.bottom), threshold) ?? start.y,
  };
  const box = cropBox(from, end, bounds, ratio);
  const sides = { left: end.x < from.x, right: end.x >= from.x, top: end.y < from.y, bottom: end.y >= from.y };
  return snapCropEdges(box, sides, lines, threshold, bounds, ratio);
}

/**
 * Snap lines with the capture's own borders added, for a canvas grown past
 * it: the capture's edge is where a crop of one screenshot most often ends.
 * `shown` is the capture as it shows (display space starts at its corner).
 */
export function withCaptureBorders(lines: SnapLines, shown: Size): SnapLines {
  const ascending = (a: number, b: number) => a - b;
  const add = (found: number[], max: number) => [...new Set([...found, 0, max])].sort(ascending);
  return { x: add(lines.x, shown.width), y: add(lines.y, shown.height) };
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
  /** A stamp's rotation, in degrees, when the Transformer turned it. */
  rotation?: number;
}

/** Transformer anchors at the corners only. */
export const CORNER_ANCHORS = ["top-left", "top-right", "bottom-left", "bottom-right"];
/** Every Transformer anchor (Konva's default). */
export const ALL_ANCHORS = [...CORNER_ANCHORS, "top-center", "middle-left", "middle-right", "bottom-center"];

/**
 * The resize handles a shape offers. Text, callouts, step badges and stamps
 * have a single size (font size, radius, longer side), so a side handle
 * could only stretch one axis; they resize from the corners, keeping their
 * ratio, as added images do.
 */
export function anchorsFor(shape: Shape | null): string[] {
  return keepsRatio(shape) ? CORNER_ANCHORS : ALL_ANCHORS;
}

/**
 * Whether resizing keeps the shape's ratio. An added image keeps it too,
 * though Shift frees it (see the Transformer's `shiftBehavior`).
 */
export function keepsRatio(shape: Shape | null): boolean {
  return (
    shape?.type === "text" ||
    shape?.type === "callout" ||
    shape?.type === "step" ||
    shape?.type === "magnify" ||
    shape?.type === "image" ||
    shape?.type === "stamp"
  );
}

/** The smallest a stamp is resized to, in capture pixels. */
export const MIN_STAMP_SIZE = 8;

/** A stamp's rotation between 0 and 360, to a hundredth of a degree; absent when it is upright. */
export function withStampRotation(shape: StampShape, degrees: number): StampShape {
  const turned = Math.round((((degrees % 360) + 360) % 360) * 100) / 100;
  const next = { ...shape };
  if (turned === 0 || turned === 360 || !Number.isFinite(turned)) delete next.rotation;
  else next.rotation = turned;
  return next;
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
      const moved = { ...shape, points };
      if (shape.control) {
        const [cx, cy] = shape.control;
        moved.control = [t.x + cx * t.scaleX, t.y + cy * t.scaleY];
      }
      if (shape.elbow) {
        const { axis, at } = shape.elbow;
        moved.elbow = { axis, at: axis === "x" ? t.x + at * t.scaleX : t.y + at * t.scaleY };
      }
      return moved;
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
    case "image":
      return {
        ...shape,
        ...normalizeRect({
          x: t.x,
          y: t.y,
          width: Math.max(MIN_SIZE, shape.width * Math.abs(t.scaleX)),
          height: Math.max(MIN_SIZE, shape.height * Math.abs(t.scaleY)),
        }),
      };
    case "magnify": {
      const side = Math.max(MIN_SIZE, shape.width * uniformScale(t));
      return { ...shape, x: t.x, y: t.y, width: side, height: side };
    }
    case "text":
      return { ...shape, x: t.x, y: t.y, fontSize: Math.max(6, shape.fontSize * uniformScale(t)) };
    case "callout": {
      // A move takes the tip along; a resize leaves it on what it points at.
      const moved = t.scaleX === 1 && t.scaleY === 1;
      const tail = moved ? { x: shape.tail.x + t.x - shape.x, y: shape.tail.y + t.y - shape.y } : shape.tail;
      return { ...shape, x: t.x, y: t.y, fontSize: Math.max(6, shape.fontSize * uniformScale(t)), tail };
    }
    case "step":
      return { ...shape, x: t.x, y: t.y, radius: Math.max(6, shape.radius * uniformScale(t)) };
    case "stamp": {
      const next = { ...shape, x: t.x, y: t.y, size: Math.max(MIN_STAMP_SIZE, shape.size * uniformScale(t)) };
      return t.rotation === undefined ? next : withStampRotation(next, t.rotation);
    }
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
  if (shape.type === "magnify") return { ...shape, x: shape.x + dx, y: shape.y + dy, spot: [shape.spot[0] + dx, shape.spot[1] + dy] };
  if ("points" in shape) return transformShape(shape, { x: dx, y: dy, scaleX: 1, scaleY: 1 });
  return transformShape(shape, { x: shape.x + dx, y: shape.y + dy, scaleX: 1, scaleY: 1 });
}

/**
 * Step badge numbers: 1, 2, 3... in the order the steps were added. A step
 * with its own `number` (a guide step's place) shows that number instead and is
 * not counted.
 */
export function stepNumbers(shapes: Shape[]): Map<string, number> {
  const numbers = new Map<string, number>();
  let counted = 0;
  for (const shape of shapes) {
    if (shape.type !== "step") continue;
    if (shape.number !== undefined) numbers.set(shape.id, shape.number);
    else numbers.set(shape.id, ++counted);
  }
  return numbers;
}

/**
 * Applies the parts of `style` a shape has: colour (not blur, spotlight or images),
 * stroke width on stroked shapes (widened for the highlighter), font size
 * on text and callouts, radius on steps, fill on boxes, the look (`background`
 * and `textStyle`, set together) on text, background on callouts, and the
 * blur mode; stamps take theirs from `restyleStamp`. A style that changes
 * nothing returns the same shape.
 */
export function restyleShape(shape: Shape, style: Partial<Style>): Shape {
  if (shape.type === "spotlight" || shape.type === "image") return shape;
  if (shape.type === "stamp") return restyleStamp(shape, style);
  if (shape.type === "blur") {
    if (!style.blurMode || style.blurMode === (shape.mode ?? "pixelate")) return shape;
    return { ...shape, mode: style.blurMode };
  }
  let next: Shape = style.color ? { ...shape, color: style.color } : shape;
  if (style.strokeWidth && "strokeWidth" in next) {
    const strokeWidth =
      next.type === "highlighter"
        ? next.band !== undefined
          ? next.band + style.strokeWidth
          : highlighterWidth(style.strokeWidth)
        : style.strokeWidth;
    if (strokeWidth !== next.strokeWidth) next = { ...next, strokeWidth };
  }
  if (style.fontSize && (next.type === "text" || next.type === "callout") && style.fontSize !== next.fontSize) {
    next = { ...next, fontSize: style.fontSize };
  }
  if (style.stepRadius && next.type === "step" && style.stepRadius !== next.radius) {
    next = { ...next, radius: style.stepRadius };
  }
  if (style.fill !== undefined && (next.type === "rect" || next.type === "ellipse")) {
    next = { ...next, fill: style.fill };
  }
  if ((style.background !== undefined || style.textStyle !== undefined) && next.type === "text") {
    const look = textLook(style);
    if (look !== textLook(next)) {
      // Only the field the look uses is kept, so a plain text matches one saved before text styles.
      const plain: TextShape = { ...next };
      delete plain.background;
      delete plain.textStyle;
      next = { ...plain, ...textLookFields(look) };
    }
  } else if (style.background !== undefined && next.type === "callout") {
    next = { ...next, background: style.background };
  }
  if (next.type === "arrow" && style.arrowStyle && style.arrowStyle !== arrowStyle(next.arrowStyle)) {
    next = { ...next, arrowStyle: style.arrowStyle };
    if (style.arrowStyle === "classic") delete next.arrowStyle;
    if (style.arrowStyle !== "elbow") delete next.elbow;
  }
  if (next.type === "magnify") {
    if (style.zoom !== undefined) next = { ...next, zoom: style.zoom };
    if (style.lens !== undefined) next = { ...next, lens: style.lens === "square" ? "square" : undefined };
    if (style.lensLine !== undefined) next = { ...next, line: style.lensLine || undefined };
  }
  return next;
}

/** The look of a text shape or of the next text: Pill when it has a background (whatever its `textStyle`), else its text style, else Plain. */
export function textLook(text: Pick<TextShape, "background" | "textStyle">): TextLook {
  if (text.background) return "pill";
  return text.textStyle === "outline" || text.textStyle === "shadow" ? text.textStyle : "plain";
}

/** The `background` and `textStyle` that give `look`, for the next text: the one it does not use is cleared. */
export function textLookStyle(look: TextLook): Pick<Style, "background" | "textStyle"> {
  return { background: look === "pill", textStyle: look === "outline" || look === "shadow" ? look : undefined };
}

/** The fields a text shape stores for `look`: none for Plain. */
export function textLookFields(look: TextLook): Pick<TextShape, "background" | "textStyle"> {
  if (look === "pill") return { background: true };
  if (look === "outline" || look === "shadow") return { textStyle: look };
  return {};
}

/**
 * Applies the parts of `style` a stamp has: the picked stamp (`stamp`), its
 * size, and a colour on stamps that take one. Picking another stamp keeps
 * the size and rotation; a keycap preset sets the label, and a blank keycap
 * keeps a keycap's label but cannot turn another stamp into one, since it
 * would have nothing to show. A stamp that starts taking a colour gets
 * `style.color`, or the first swatch. Nothing changed returns the same shape.
 */
export function restyleStamp(shape: StampShape, style: Partial<Style>): StampShape {
  let next = shape;
  const pick = style.stamp ? stampPick(style.stamp) : null;
  if (pick && !(needsLabel(pick) && shape.name !== KEYCAP.name)) {
    const label = pick.name === KEYCAP.name ? (pick.label ?? shape.label) : undefined;
    if (pick.name !== shape.name || label !== shape.label) {
      next = { ...shape, name: pick.name };
      if (label) next.label = label;
      else delete next.label;
      if (!takesColor(pick.name)) delete next.color;
      else if (!next.color) next.color = style.color ?? COLORS[0];
    }
  }
  if (style.color && takesColor(next.name) && next.color !== style.color) next = { ...next, color: style.color };
  if (style.stampSize && style.stampSize !== next.size) next = { ...next, size: style.stampSize };
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
 * ⌥ with the Crop or Cut out tool, where it crops or cuts without snapping
 * instead.
 */
export function modifierTool(event: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }, active?: Tool): Tool | null {
  if (event.ctrlKey || event.metaKey) return "rect";
  if (event.altKey && active !== "crop" && active !== "cut") return "arrow";
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

/** The drop shadow behind Shadow text: black, or white behind text too dark for a black shadow to show. */
export function textShadowColor(color: string): string {
  const channels = hexChannels(color);
  if (!channels) return "#000000";
  const [r, g, b] = channels;
  return (r * 299 + g * 587 + b * 114) / 1000 < 64 ? "#ffffff" : "#000000";
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

/**
 * Moves a shape one place up (1, in front of the next) or down (-1) the
 * drawing order, which is its place in `doc.shapes`. At either end the
 * document comes back unchanged.
 */
export function reorderShape(doc: Annotations, id: string, direction: 1 | -1): Annotations {
  const from = doc.shapes.findIndex((shape) => shape.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= doc.shapes.length) return doc;
  const shapes = [...doc.shapes];
  [shapes[from], shapes[to]] = [shapes[to], shapes[from]];
  return { ...doc, shapes };
}

/** An added image at its own pixel size, centred on `at`. */
export function imageAt(src: string, size: { width: number; height: number }, at: Point, id = newId()): ImageShape {
  return { id, type: "image", src, x: Math.round(at.x - size.width / 2), y: Math.round(at.y - size.height / 2), ...size };
}

/**
 * An added image at its own pixel size, level with the capture's top and
 * just right of `canvas` (the capture and the images already added), so
 * pasted images line up side by side.
 */
export function imageBeside(src: string, size: { width: number; height: number }, canvas: Rect, id = newId()): ImageShape {
  return { id, type: "image", src, x: canvas.x + canvas.width, y: 0, ...size };
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
