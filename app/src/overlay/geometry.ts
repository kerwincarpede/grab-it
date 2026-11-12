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
