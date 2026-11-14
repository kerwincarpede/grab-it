/** A rectangle in CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Drags shorter than this are clicks, which pick the window under the cursor. */
export const DRAG_THRESHOLD = 4;

/** The rectangle between two corners, whichever way the user dragged. */
export function boxFromPoints(a: Point, b: Point): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function isDrag(box: Box): boolean {
  return box.width >= DRAG_THRESHOLD || box.height >= DRAG_THRESHOLD;
}

/**
 * Scales a box from monitor units (as the backend reports windows) into the
 * overlay's CSS pixels.
 */
export function monitorToCss(
  box: Box,
  monitor: { width: number; height: number },
  viewport: { width: number; height: number },
): Box {
  const sx = monitor.width > 0 ? viewport.width / monitor.width : 1;
  const sy = monitor.height > 0 ? viewport.height / monitor.height : 1;
  return { x: box.x * sx, y: box.y * sy, width: box.width * sx, height: box.height * sy };
}

export function contains(box: Box, point: Point): boolean {
  return (
    point.x >= box.x &&
    point.y >= box.y &&
    point.x < box.x + box.width &&
    point.y < box.y + box.height
  );
}

/** The frontmost item under `point`; items are ordered front to back. */
export function topmostAt<T extends { box: Box }>(items: T[], point: Point): T | undefined {
  return items.find((item) => contains(item.box, point));
}

export interface Size {
  width: number;
  height: number;
}

/** A drag in progress: where it began and where the moving corner is now. */
export interface Drag {
  anchor: Point;
  head: Point;
}

/**
 * The corner that makes `anchor`→`point` a square: the longer side wins, so
 * the square grows with the cursor instead of lagging behind it. With
 * `bounds`, the square stops growing where it would leave the screen.
 */
export function squareHead(anchor: Point, point: Point, bounds?: Size): Point {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  // `|| 1` keeps a straight horizontal or vertical drag growing down-right.
  const signX = Math.sign(dx) || 1;
  const signY = Math.sign(dy) || 1;
  let side = Math.max(Math.abs(dx), Math.abs(dy));
  if (bounds) {
    const roomX = signX > 0 ? bounds.width - anchor.x : anchor.x;
    const roomY = signY > 0 ? bounds.height - anchor.y : anchor.y;
    side = Math.max(Math.min(side, roomX, roomY), 0);
  }
  return { x: anchor.x + side * signX, y: anchor.y + side * signY };
}

/** The selection a drag describes; `square` is the Shift constraint. */
export function dragBox(drag: Drag, square = false, bounds?: Size): Box {
  const head = square ? squareHead(drag.anchor, drag.head, bounds) : drag.head;
  return boxFromPoints(drag.anchor, head);
}

/**
 * Moves a box by `delta`, stopping at the edges of `bounds` so a selection
 * cannot be pushed off the screen. A box larger than the bounds stays put.
 */
export function clampedDelta(box: Box, delta: Point, bounds: Size): Point {
  const clamp = (value: number, min: number, max: number) =>
    max < min ? 0 : Math.min(Math.max(value, min), max);
  return {
    x: clamp(delta.x, -box.x, bounds.width - box.x - box.width),
    y: clamp(delta.y, -box.y, bounds.height - box.y - box.height),
  };
}

/**
 * Advances a drag as the cursor goes from `from` to `to`. Normally the moving
 * corner follows the cursor; with `move` (Space held) the whole selection
 * travels with it instead, keeping its size.
 */
export function advanceDrag(
  drag: Drag,
  from: Point,
  to: Point,
  options: { move: boolean; square: boolean; bounds: Size },
): Drag {
  if (!options.move) return { anchor: drag.anchor, head: to };
  const delta = clampedDelta(
    dragBox(drag, options.square, options.bounds),
    { x: to.x - from.x, y: to.y - from.y },
    options.bounds,
  );
  return {
    anchor: { x: drag.anchor.x + delta.x, y: drag.anchor.y + delta.y },
    head: { x: drag.head.x + delta.x, y: drag.head.y + delta.y },
  };
}

/** The size of a CSS-pixel box in image pixels, as it will be captured. */
export function imageSize(box: Box, scale: number): Size {
  return { width: Math.round(box.width * scale), height: Math.round(box.height * scale) };
}

/** The image pixel under a CSS-pixel point, kept inside the image. */
export function imagePixelAt(point: Point, scale: number, image: Size): Point {
  const clamp = (value: number, size: number) =>
    Math.min(Math.max(Math.floor(value * scale), 0), Math.max(size - 1, 0));
  return { x: clamp(point.x, image.width), y: clamp(point.y, image.height) };
}

export interface LabelPlacement {
  /** `inside` is the fallback when the selection spans the full height. */
  side: "above" | "below" | "inside";
  /** Which edge of the selection the label lines up with. */
  align: "start" | "end";
}

/**
 * Where a label of `label` size goes so it stays outside the selection and on
 * screen: above when there is room, else below, else just inside the top.
 */
export function labelPlacement(box: Box, label: Size, viewport: Size): LabelPlacement {
  const side =
    box.y >= label.height
      ? "above"
      : box.y + box.height + label.height <= viewport.height
        ? "below"
        : "inside";
  return { side, align: box.x + label.width <= viewport.width ? "start" : "end" };
}

/**
 * Top-left corner for a floating panel that trails the cursor down-right,
 * flipping to the other side of the cursor near the right and bottom edges.
 */
export function floatingPosition(point: Point, panel: Size, viewport: Size, offset: number): Point {
  const place = (at: number, size: number, limit: number) => {
    const after = at + offset;
    const position = after + size <= limit ? after : at - offset - size;
    return Math.max(position, 0);
  };
  return {
    x: place(point.x, panel.width, viewport.width),
    y: place(point.y, panel.height, viewport.height),
  };
}

/** `#RRGGBB` for an 8-bit colour, as design tools write it. */
export function toHex(red: number, green: number, blue: number): string {
  const channel = (value: number) =>
    Math.min(Math.max(Math.round(value), 0), 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(red)}${channel(green)}${channel(blue)}`.toUpperCase();
}

/**
 * A CSS `clip-path` covering the whole `viewport` except `box`, cut out with
 * rounded corners of `radius`: the blurred screen around a hovered window.
 * The path keeps the same commands for every box, so the browser can
 * animate from one window to the next.
 */
export function cutoutPath(box: Box, viewport: Size, radius: number): string {
  const r = Math.max(0, Math.min(radius, box.width / 2, box.height / 2));
  const { x, y, width: w, height: h } = box;
  const n = (value: number) => Number(value.toFixed(2));
  const outer = `M0 0H${n(viewport.width)}V${n(viewport.height)}H0Z`;
  const hole =
    `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}` +
    `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}` +
    `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}` +
    `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
  return `path(evenodd, "${outer} ${hole}")`;
}

/**
 * A CSS transform that stretches a 1 px square at the origin over `box`.
 *
 * The pieces that follow a drag (the tint around the selection and its
 * border) are solid colours placed this way, so moving them is a change of
 * transform alone: no layout, nothing repainted and no layer the size of the
 * selection to draw again on every pointer move.
 */
export function stretch(box: Box): string {
  const n = (value: number) => Number(value.toFixed(2));
  return `translate(${n(box.x)}px, ${n(box.y)}px) scale(${n(box.width)}, ${n(box.height)})`;
}

/** A CSS transform that moves an element at the origin to `point`. */
export function moveTo(point: Point): string {
  const n = (value: number) => Number(value.toFixed(2));
  return `translate(${n(point.x)}px, ${n(point.y)}px)`;
}

/**
 * The four rectangles that cover `viewport` around `hole`: above it, below
 * it, and left and right of it. Without a hole the first covers everything.
 */
export function surround(hole: Box | null, viewport: Size): [Box, Box, Box, Box] {
  const { width, height } = viewport;
  if (!hole) {
    const none = { x: 0, y: 0, width: 0, height: 0 };
    return [{ x: 0, y: 0, width, height }, none, none, none];
  }
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  const left = clamp(hole.x, width);
  const right = clamp(hole.x + hole.width, width);
  const top = clamp(hole.y, height);
  const bottom = clamp(hole.y + hole.height, height);
  return [
    { x: 0, y: 0, width, height: top },
    { x: 0, y: bottom, width, height: height - bottom },
    { x: 0, y: top, width: left, height: bottom - top },
    { x: right, y: top, width: width - right, height: bottom - top },
  ];
}

/** Where the piece that rounds off each corner of `hole` goes: its top-left. */
export function holeCorners(hole: Box, radius: number): [Point, Point, Point, Point] {
  const right = hole.x + hole.width - radius;
  const bottom = hole.y + hole.height - radius;
  return [
    { x: hole.x, y: hole.y },
    { x: right, y: hole.y },
    { x: hole.x, y: bottom },
    { x: right, y: bottom },
  ];
}

/** The border's thickness, just outside the selection. */
const FRAME_EDGE = 1;
/** How far the corner ticks reach outside the selection, and their length. */
const TICK_OUTSET = 3;
const TICK_LENGTH = 12;

/**
 * The selection's border as rectangles: four edges just outside `box`, so
 * the selected pixels stay untouched, and the squares the corner ticks are
 * drawn in (top left, top right, bottom left, bottom right). A selection
 * shorter than a tick gets shorter ticks.
 */
export function frameParts(box: Box): { edges: [Box, Box, Box, Box]; ticks: [Box, Box, Box, Box] } {
  const { x, y, width, height } = box;
  const e = FRAME_EDGE;
  const outer = {
    x: x - TICK_OUTSET,
    y: y - TICK_OUTSET,
    width: width + TICK_OUTSET * 2,
    height: height + TICK_OUTSET * 2,
  };
  const tick = {
    width: Math.min(TICK_LENGTH, outer.width),
    height: Math.min(TICK_LENGTH, outer.height),
  };
  const farX = outer.x + outer.width - tick.width;
  const farY = outer.y + outer.height - tick.height;
  return {
    edges: [
      { x: x - e, y: y - e, width: width + e * 2, height: e },
      { x: x - e, y: y + height, width: width + e * 2, height: e },
      { x: x - e, y, width: e, height },
      { x: x + width, y, width: e, height },
    ],
    ticks: [
      { x: outer.x, y: outer.y, ...tick },
      { x: farX, y: outer.y, ...tick },
      { x: outer.x, y: farY, ...tick },
      { x: farX, y: farY, ...tick },
    ],
  };
}

/** The gap between a selection and its label, in CSS px. */
const LABEL_GAP = 8;

/**
 * A CSS transform that puts a label at the origin where `placement` says,
 * beside `box`. The label's own size is not known here, so the browser
 * shifts it by its own width or height where it hangs from its far edge.
 */
export function labelTransform(box: Box, placement: LabelPlacement): string {
  const inside = placement.side === "inside";
  const end = placement.align === "end";
  const inset = inside ? LABEL_GAP : 0;
  const x = end ? box.x + box.width - inset : box.x + inset;
  const y =
    placement.side === "above"
      ? box.y - LABEL_GAP
      : placement.side === "below"
        ? box.y + box.height + LABEL_GAP
        : box.y + LABEL_GAP;
  const shift = `translate(${end ? "-100%" : "0"}, ${placement.side === "above" ? "-100%" : "0"})`;
  return `${moveTo({ x, y })} ${shift}`;
}

/** The hint's gap below the menu bar (or the top edge), in CSS px. */
const HINT_GAP = 12;

/**
 * Where the hint's top goes, in CSS px: just below the menu bar or camera
 * notch, given how far down they reach as a share of the screen's height.
 */
export function hintTop(topInset: number | undefined, viewHeight: number): number {
  const share = typeof topInset === "number" && Number.isFinite(topInset) ? Math.min(Math.max(topInset, 0), 0.2) : 0;
  return Math.round(share * viewHeight) + HINT_GAP;
}
