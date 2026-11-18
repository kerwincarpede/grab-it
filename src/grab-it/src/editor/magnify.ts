import type Konva from "konva";
import type { CaptureImage } from "./cut";
import type { MagnifyShape } from "./model";
import { roundedRectPath } from "./flatten";

/** The lens outline, in the annotation node's local coordinates. */
export function lensPath(ctx: Konva.Context, shape: MagnifyShape) {
  const side = Math.abs(shape.width);
  ctx.beginPath();
  if (shape.lens === "square") roundedRectPath(ctx, { x: 0, y: 0, width: side, height: side }, side * 0.12);
  else ctx.arc(side / 2, side / 2, side / 2, 0, Math.PI * 2);
  ctx.closePath();
}

/** Shared by the editor and the content layer's export canvas. */
export function magnifyScene(shape: MagnifyShape, image: CaptureImage | null) {
  return (ctx: Konva.Context, node: Konva.Shape) => {
    const side = Math.abs(shape.width);
    if (side < 1) return;
    lensPath(ctx, shape);
    ctx.fillShape(node);
    ctx.save();
    ctx.clip();
    if (image) {
      const sourceSide = side / shape.zoom;
      ctx.drawImage(image, shape.spot[0] - sourceSide / 2, shape.spot[1] - sourceSide / 2,
        sourceSide, sourceSide, 0, 0, side, side);
    }
    ctx.restore();
    ctx.strokeShape(node);
  };
}

/** A ray from the spot to the lens's edge; nothing is drawn for a spot inside it. */
export function magnifyLinePoints(shape: MagnifyShape): number[] {
  const side = Math.abs(shape.width);
  const half = side / 2;
  const dx = shape.spot[0] - (shape.x + half);
  const dy = shape.spot[1] - (shape.y + half);
  const distance = Math.hypot(dx, dy);
  if (!distance || !side) return [];
  const inside = (t: number) => {
    if (shape.lens !== "square") return distance * t <= half;
    const radius = side * 0.12;
    const x = Math.max(0, Math.abs(dx * t) - (half - radius));
    const y = Math.max(0, Math.abs(dy * t) - (half - radius));
    return Math.hypot(x, y) <= radius;
  };
  if (inside(1)) return [];
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) / 2;
    if (inside(mid)) low = mid;
    else high = mid;
  }
  return [...shape.spot, shape.x + half + dx * low, shape.y + half + dy * low];
}
