import type { Annotations, Cut, CutEdge, Rect, Shape } from "./model";
import { calloutBubble } from "./callout";
import { textSize, type Orientation } from "./orient";
import { cropToCapture, MIN_SIZE, normalizeRect } from "./tools";

/**
 * Cut out: strips removed from the capture, the parts either side joined.
 * Cuts are applied first, before the crop and orientation, and shapes and
 * the crop live in the pixels of the joined image. Each cut's `start` and
 * `end` are in the image the earlier cuts left.
 */

/** How deep the teeth of a zigzag or torn edge reach into each part. */
export const CUT_DEPTH = 12;
/** The see-through space a zigzag or torn join leaves between the parts. A straight join leaves none. */
export const CUT_GAP = 8;
/** How far apart, along the edge, a torn edge's points are. */
const TORN_STEP = 4;

type Size = { width: number; height: number };

/** The capture as the editor draws it: the loaded image, or a canvas of it with its cuts made. */
export type CaptureImage = HTMLImageElement | HTMLCanvasElement;

/** True when a cut leaves a see-through gap, which the backdrop shows through. */
export function hasCutGaps(cuts: Cut[] | undefined): boolean {
  return (cuts ?? []).some((cut) => cutGap(cut.edge) > 0);
}

/** The space a join leaves between its parts. */
export function cutGap(edge: CutEdge): number {
  return edge === "straight" ? 0 : CUT_GAP;
}

/** How far everything past the strip moves back: the strip, less the gap the join leaves. */
export function cutShift(cut: Cut): number {
  return cut.end - cut.start - cutGap(cut.edge);
}

/** The image's size after one cut. */
export function cutSize(size: Size, cut: Cut): Size {
  const shift = cutShift(cut);
  return cut.axis === "y" ? { width: size.width, height: size.height - shift } : { width: size.width - shift, height: size.height };
}

/** The image's size after every cut, in order. */
export function joinedSize(size: Size, cuts: Cut[] | undefined): Size {
  return (cuts ?? []).reduce(cutSize, { width: size.width, height: size.height });
}

/** A seed for a new torn edge. */
export function newCutSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** A small seeded random number generator (mulberry32): the same seed gives the same numbers. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The jagged line a join's parts are cut along, as `[along, depth]` points
 * from 0 to `length` along the edge, each depth from 0 to `CUT_DEPTH`. A
 * zigzag has even teeth; a torn edge wanders, drawn from the cut's seed.
 * A straight edge has none.
 */
export function edgeProfile(cut: Pick<Cut, "edge" | "seed">, length: number): [number, number][] {
  if (cut.edge === "straight" || length <= 0) return [];
  const points: [number, number][] = [];
  if (cut.edge === "zigzag") {
    for (let at = 0, i = 0; at < length + CUT_DEPTH; at += CUT_DEPTH, i += 1) points.push([Math.min(at, length), i % 2 === 0 ? 0 : CUT_DEPTH]);
    return points;
  }
  const random = seededRandom(cut.seed ?? 0);
  let depth = CUT_DEPTH / 2;
  for (let at = 0; at < length + TORN_STEP; at += TORN_STEP) {
    points.push([Math.min(at, length), depth]);
    depth = Math.min(CUT_DEPTH, Math.max(0, depth + (random() - 0.5) * 7));
  }
  return points;
}

/**
 * The image with one strip cut out: the part before it, then (for a zigzag
 * or torn join) a see-through gap, then the part after it. A jagged join
 * cuts both parts along the same line, so their edges match. A canvas of the
 * right size that could not be drawn on (jsdom) is returned blank.
 */
export function joinCanvas(source: CanvasImageSource, size: Size, cut: Cut): HTMLCanvasElement {
  const out = cutSize(size, cut);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(out.width));
  canvas.height = Math.max(1, Math.round(out.height));
  let context: CanvasRenderingContext2D | null = null;
  try {
    context = canvas.getContext("2d");
  } catch {
    context = null;
  }
  if (!context) return canvas;
  const ctx = context;
  const vertical = cut.axis === "y";
  // Along the axis: how long the capture is; across it, how wide the edge is.
  const length = vertical ? size.height : size.width;
  const across = vertical ? size.width : size.height;
  const joinedLength = vertical ? out.height : out.width;
  const gap = cutGap(cut.edge);
  /** A point given along the edge and along the axis, in canvas x, y. */
  const at = (along: number, depth: number): [number, number] => (vertical ? [along, depth] : [depth, along]);
  /** Draws the source's `from`–`to` stretch along the axis at `place`, clipped to `clip` when given. */
  const part = (from: number, to: number, place: number, clip: [number, number][] | null) => {
    if (to <= from) return;
    ctx.save();
    if (clip) {
      ctx.beginPath();
      clip.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.closePath();
      ctx.clip();
    }
    if (vertical) ctx.drawImage(source, 0, from, across, to - from, 0, place, across, to - from);
    else ctx.drawImage(source, from, 0, to - from, across, place, 0, to - from, across);
    ctx.restore();
  };
  const profile = edgeProfile(cut, across);
  if (profile.length === 0) {
    part(0, cut.start, 0, null);
    part(cut.end, length, cut.start, null);
    return canvas;
  }
  // The part before keeps what lies before start − depth; the part after begins CUT_DEPTH + gap past that line.
  const before = [at(0, 0), at(across, 0), ...[...profile].reverse().map(([along, depth]) => at(along, cut.start - depth))];
  const after = [
    at(0, joinedLength),
    at(across, joinedLength),
    ...[...profile].reverse().map(([along, depth]) => at(along, cut.start + gap + CUT_DEPTH - depth)),
  ];
  part(0, cut.start, 0, before);
  part(cut.end, length, cut.start + gap, after);
  return canvas;
}

/** The capture with every cut made, in order: what the editor shows, blurs and exports. The image itself without cuts. */
export function joinedImage<T extends CanvasImageSource & Size>(image: T, cuts: Cut[] | undefined): T | HTMLCanvasElement {
  let current: T | HTMLCanvasElement = image;
  let size: Size = { width: image.width, height: image.height };
  for (const cut of cuts ?? []) {
    current = joinCanvas(current, size, cut);
    size = cutSize(size, cut);
  }
  return current;
}

/** A coordinate along the cut's axis after the cut: past the strip it moves back; inside it, it lands on the join. */
export function shiftValue(value: number, cut: Cut): number {
  if (value <= cut.start) return value;
  if (value >= cut.end) return value - cutShift(cut);
  return cut.start;
}

/** A coordinate after the cut put back where it was before it: past the join it moves forward again. */
export function restoreValue(value: number, cut: Cut): number {
  return value > cut.start + cutGap(cut.edge) ? value + cutShift(cut) : value;
}

/** How far a shape reaches along `axis`: its lowest and highest coordinate. */
function extent(shape: Shape, axis: "x" | "y"): [number, number] {
  const i = axis === "x" ? 0 : 1;
  switch (shape.type) {
    case "arrow":
    case "line":
    case "freehand":
    case "highlighter": {
      const values = shape.points.filter((_, k) => k % 2 === i);
      if ((shape.type === "arrow" || shape.type === "line") && shape.control) values.push(shape.control[i]);
      return [Math.min(...values), Math.max(...values)];
    }
    case "text": {
      const box = textSize(shape.text, shape.fontSize);
      return axis === "x" ? [shape.x, shape.x + box.width] : [shape.y, shape.y + box.height];
    }
    case "callout": {
      // The bubble around its text, and the tail's tip.
      const bubble = calloutBubble(shape);
      const [low, high] = axis === "x" ? [shape.x + bubble.x, shape.x + bubble.x + bubble.width] : [shape.y + bubble.y, shape.y + bubble.y + bubble.height];
      return [Math.min(low, shape.tail[axis]), Math.max(high, shape.tail[axis])];
    }
    case "step":
      return axis === "x" ? [shape.x - shape.radius, shape.x + shape.radius] : [shape.y - shape.radius, shape.y + shape.radius];
    default: {
      const rect = normalizeRect(shape);
      return axis === "x" ? [rect.x, rect.x + rect.width] : [rect.y, rect.y + rect.height];
    }
  }
}

/** Every coordinate of `shape` along `axis` passed through `map`. */
function mapShape(shape: Shape, axis: "x" | "y", map: (value: number) => number): Shape {
  const i = axis === "x" ? 0 : 1;
  const pair = (values: [number, number]): [number, number] => (i === 0 ? [map(values[0]), values[1]] : [values[0], map(values[1])]);
  switch (shape.type) {
    case "arrow":
    case "line": {
      const points = shape.points.map((value, k) => (k % 2 === i ? map(value) : value));
      return shape.control ? { ...shape, points, control: pair(shape.control) } : { ...shape, points };
    }
    case "freehand":
    case "highlighter":
      return { ...shape, points: shape.points.map((value, k) => (k % 2 === i ? map(value) : value)) };
    case "text":
    case "step":
      return axis === "x" ? { ...shape, x: map(shape.x) } : { ...shape, y: map(shape.y) };
    case "callout":
      // The text's corner and the tail's tip move on their own.
      return axis === "x"
        ? { ...shape, x: map(shape.x), tail: { ...shape.tail, x: map(shape.tail.x) } }
        : { ...shape, y: map(shape.y), tail: { ...shape.tail, y: map(shape.tail.y) } };
    case "magnify": {
      // A lens stays square: its centre moves, and its spot.
      const half = shape.width / 2;
      const centre = map((axis === "x" ? shape.x : shape.y) + half) - half;
      return { ...shape, ...(axis === "x" ? { x: centre } : { y: centre }), spot: pair(shape.spot) };
    }
    default: {
      const rect = normalizeRect(shape);
      if (axis === "x") {
        const x = map(rect.x);
        return { ...shape, ...rect, x, width: map(rect.x + rect.width) - x };
      }
      const y = map(rect.y);
      return { ...shape, ...rect, y, height: map(rect.y + rect.height) - y };
    }
  }
}

/** A rectangle's span along `axis` passed through `map`; null when nothing of it is left. */
function mapRect(rect: Rect, axis: "x" | "y", map: (value: number) => number): Rect | null {
  if (axis === "x") {
    const x = map(rect.x);
    const width = map(rect.x + rect.width) - x;
    return width < MIN_SIZE ? null : { ...rect, x, width };
  }
  const y = map(rect.y);
  const height = map(rect.y + rect.height) - y;
  return height < MIN_SIZE ? null : { ...rect, y, height };
}

/**
 * The document with `cut` made: the cut added, every shape past the strip
 * moved back to close the gap, a shape wholly inside the strip removed,
 * one crossing it shortened to the join, and the crop shrunk by its overlap
 * with the strip (gone when nothing of it is left).
 */
export function cutAnnotations(doc: Annotations, cut: Cut): Annotations {
  const map = (value: number) => shiftValue(value, cut);
  const shapes = doc.shapes
    .filter((shape) => {
      const [low, high] = extent(shape, cut.axis);
      return !(low >= cut.start && high <= cut.end);
    })
    .map((shape) => mapShape(shape, cut.axis, map));
  return {
    ...doc,
    shapes,
    cuts: [...(doc.cuts ?? []), cut],
    crop: doc.crop ? mapRect(doc.crop, cut.axis, map) : (doc.crop ?? null),
  };
}

/**
 * Restore strips: every cut undone, last to first, moving shapes and the
 * crop past each join forward again. Shapes that were shortened to a join
 * or removed stay as they are.
 */
export function restoreStrips(doc: Annotations): Annotations {
  const cuts = doc.cuts ?? [];
  if (cuts.length === 0) return doc;
  let shapes = doc.shapes;
  let crop = doc.crop ?? null;
  for (const cut of [...cuts].reverse()) {
    const map = (value: number) => restoreValue(value, cut);
    shapes = shapes.map((shape) => mapShape(shape, cut.axis, map));
    if (crop) crop = mapRect(crop, cut.axis, map);
  }
  const next: Annotations = { ...doc, shapes, crop };
  delete next.cuts;
  return next;
}

/** Which way a strip runs as the capture shows: across (a horizontal strip) or down (a vertical one). */
export type StripDirection = "horizontal" | "vertical";

/**
 * The strip a drag from `from` to `to` marks on show: as wide (or tall) as
 * the whole image, between the two points along the other way, in whole
 * pixels inside the image.
 */
export function stripBox(from: number, to: number, direction: StripDirection, shown: Size): Rect {
  const limit = direction === "horizontal" ? shown.height : shown.width;
  const low = Math.min(limit, Math.max(0, Math.round(Math.min(from, to))));
  const high = Math.min(limit, Math.max(low, Math.round(Math.max(from, to))));
  return direction === "horizontal"
    ? { x: 0, y: low, width: shown.width, height: high - low }
    : { x: low, y: 0, width: high - low, height: shown.height };
}

/**
 * The cut a strip on show makes, in the pixels of the joined image (`size`)
 * before it is turned and mirrored by `o`, or null for a strip thinner than
 * `MIN_SIZE` or one that would leave nothing on either side.
 */
export function cutFromStrip(shown: Rect, size: Size, o: Orientation, edge: CutEdge, seed?: number): Cut | null {
  const rect = cropToCapture(shown, size, o);
  // A strip spanning the whole width removes rows.
  const axis = rect.width >= size.width && rect.height < size.height ? "y" : "x";
  const start = axis === "y" ? rect.y : rect.x;
  const end = axis === "y" ? rect.y + rect.height : rect.x + rect.width;
  const length = axis === "y" ? size.height : size.width;
  if (end - start < MIN_SIZE || start <= 0 || end >= length) return null;
  return { axis, start, end, edge, ...(edge === "torn" ? { seed: seed ?? newCutSeed() } : {}) };
}

/**
 * Rectangles found on the original capture (words, faces) in the pixels of
 * the joined image: moved through every cut in order, those wholly inside a
 * strip dropped.
 */
export function rectsThroughCuts(rects: Rect[], cuts: Cut[] | undefined): Rect[] {
  let current = rects;
  for (const cut of cuts ?? []) {
    const map = (value: number) => shiftValue(value, cut);
    current = current.flatMap((rect) => {
      const moved = mapRect(rect, cut.axis, map);
      return moved ? [moved] : [];
    });
  }
  return current;
}

/** A point on the joined image back on the original capture, through every cut last to first. */
export function pointBeforeCuts(point: { x: number; y: number }, cuts: Cut[] | undefined): { x: number; y: number } {
  let { x, y } = point;
  for (const cut of [...(cuts ?? [])].reverse()) {
    if (cut.axis === "x") x = restoreValue(x, cut);
    else y = restoreValue(y, cut);
  }
  return { x, y };
}
