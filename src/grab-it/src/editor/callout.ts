import type { Point, Rect, Rotation } from "./model";
import { textSize } from "./orient";

/* A callout's bubble and tail, local to its text's corner (the shape's x, y). */

/** The space between a label's text and the edge of its pill or bubble. */
export const labelPadding = (fontSize: number) => fontSize * 0.35;
/** The corner radius of a label's pill or bubble. */
export const labelRadius = (fontSize: number) => fontSize * 0.4;
/** How thick a bubble without a background is outlined. */
export const calloutOutline = (fontSize: number) => Math.max(2, fontSize / 12);

/**
 * The bubble around a callout's text: the text's box plus the pill's
 * padding. Upright text turns about its centre, so a quarter turn swaps the
 * bubble's sides around the same centre.
 */
export function calloutBubble(label: { text: string; fontSize: number }, rotation: Rotation = 0): Rect {
  const box = textSize(label.text, label.fontSize);
  const padding = labelPadding(label.fontSize);
  const across = box.width + padding * 2;
  const down = box.height + padding * 2;
  const [width, height] = rotation === 90 || rotation === 270 ? [down, across] : [across, down];
  return { x: box.width / 2 - width / 2, y: box.height / 2 - height / 2, width, height };
}

/**
 * The tail as `[x1, y1, tipX, tipY, x2, y2]`: a wedge from a base across
 * the bubble's centre to `tip`. It winds the way `roundedRectPath` does, so
 * bubble and tail fill as one shape. Empty when the tip is on the centre.
 */
export function calloutWedge(bubble: Rect, tip: Point, fontSize: number): number[] {
  const centre = { x: bubble.x + bubble.width / 2, y: bubble.y + bubble.height / 2 };
  const dx = tip.x - centre.x;
  const dy = tip.y - centre.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return [];
  const half = Math.min(fontSize * 0.45, (Math.min(bubble.width, bubble.height) / 2) * 0.8);
  const across = { x: (-dy / length) * half, y: (dx / length) * half };
  let a = { x: centre.x + across.x, y: centre.y + across.y };
  let b = { x: centre.x - across.x, y: centre.y - across.y };
  // Twice the signed area, y down: positive runs clockwise on screen, as the bubble does.
  const area = a.x * tip.y - tip.x * a.y + (tip.x * b.y - b.x * tip.y) + (b.x * a.y - a.x * b.y);
  if (area < 0) [a, b] = [b, a];
  return [a.x, a.y, tip.x, tip.y, b.x, b.y];
}

/** Where a plain click's tail points, as it shows: below and left of the text's corner. */
export function defaultTailOffset(fontSize: number): Point {
  return { x: -fontSize, y: fontSize * 2.5 };
}
