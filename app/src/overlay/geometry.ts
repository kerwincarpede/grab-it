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
