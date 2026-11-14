import type Konva from "konva";
import { backdropColors, type Backdrop, type Rect } from "./model";

export interface View {
  scale: number;
  x: number;
  y: number;
}

export type ExportFormat = "png" | "jpg";

/** The area to flatten, in stage (screen) pixels, and the ratio that maps it back to capture pixels. */
export function exportArea(crop: Rect | null | undefined, image: { width: number; height: number }, view: View) {
  const area = crop ?? { x: 0, y: 0, width: image.width, height: image.height };
  return {
    x: view.x + area.x * view.scale,
    y: view.y + area.y * view.scale,
    width: area.width * view.scale,
    height: area.height * view.scale,
    pixelRatio: 1 / view.scale,
  };
}

/** Picks the format from the chosen file name, adding `.png` when it has none. */
export function exportTarget(path: string): { path: string; format: ExportFormat } {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return { path, format: "jpg" };
  if (lower.endsWith(".png")) return { path, format: "png" };
  return { path: `${path}.png`, format: "png" };
}

/** Where a backdrop puts the capture, in output pixels. */
export interface BackdropLayout {
  /** The size of the whole output image. */
  width: number;
  height: number;
  /** The top-left corner of the capture inside it. */
  x: number;
  y: number;
  /** The capture's corner radius, never more than half its shorter side. */
  radius: number;
  shadow: { blur: number; offsetY: number; opacity: number } | null;
}

/**
 * Lays a capture of `size` out on its backdrop: the output grows by the
 * padding on every side. Without a backdrop the capture is the output.
 */
export function backdropLayout(size: { width: number; height: number }, backdrop: Backdrop | null | undefined): BackdropLayout {
  if (!backdrop) return { width: size.width, height: size.height, x: 0, y: 0, radius: 0, shadow: null };
  // Whole pixels, so the capture is not resampled.
  const padding = Math.max(0, Math.round(backdrop.padding));
  const shorter = Math.min(size.width, size.height);
  // The shadow scales with the capture, and stays visible on small ones.
  const blur = Math.round(Math.max(12, shorter * 0.06));
  return {
    width: size.width + padding * 2,
    height: size.height + padding * 2,
    x: padding,
    y: padding,
    radius: Math.max(0, Math.min(backdrop.radius, shorter / 2)),
    shadow: backdrop.shadow ? { blur, offsetY: Math.round(blur / 3), opacity: 0.35 } : null,
  };
}

type PathContext = Pick<CanvasRenderingContext2D, "moveTo" | "lineTo" | "arcTo" | "closePath">;

/** Adds a rounded rectangle to the current path; works on a canvas or Konva context. */
export function roundedRectPath(ctx: PathContext, rect: Rect, radius: number): void {
  const { x, y, width, height } = rect;
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/** Evenly spaced gradient stops as Konva takes them: `[0, colour, ..., 1, colour]`. */
export function gradientStops(colors: string[]): (number | string)[] {
  return colors.flatMap((color, i) => [colors.length > 1 ? i / (colors.length - 1) : 0, color]);
}

/** Draws the flattened capture on its backdrop: fill, shadow, then the capture with rounded corners. */
export function composeBackdrop(source: HTMLCanvasElement, backdrop: Backdrop): HTMLCanvasElement {
  const layout = backdropLayout({ width: source.width, height: source.height }, backdrop);
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not draw the backdrop");

  const colors = backdropColors(backdrop.fill);
  if (colors.length > 1) {
    const gradient = ctx.createLinearGradient(0, 0, layout.width, layout.height);
    for (let i = 0; i < colors.length; i += 1) gradient.addColorStop(i / (colors.length - 1), colors[i]);
    ctx.fillStyle = gradient;
  } else {
    ctx.fillStyle = colors[0];
  }
  ctx.fillRect(0, 0, layout.width, layout.height);

  const capture = { x: layout.x, y: layout.y, width: source.width, height: source.height };
  if (layout.shadow) {
    // An opaque plate the size of the capture casts the shadow; the capture covers it.
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${layout.shadow.opacity})`;
    ctx.shadowBlur = layout.shadow.blur;
    ctx.shadowOffsetY = layout.shadow.offsetY;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    roundedRectPath(ctx, capture, layout.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  roundedRectPath(ctx, capture, layout.radius);
  ctx.clip();
  ctx.drawImage(source, layout.x, layout.y);
  ctx.restore();
  return canvas;
}

/**
 * Renders the capture and its annotations (the content layer only, never
 * the selection handles) at capture resolution, cropped, then framed by the
 * backdrop when there is one.
 */
export async function flatten(
  layer: Konva.Layer,
  doc: { crop?: Rect | null; backdrop?: Backdrop | null },
  image: { width: number; height: number },
  view: View,
  format: ExportFormat,
): Promise<Uint8Array> {
  const flat = layer.toCanvas(exportArea(doc.crop, image, view));
  const canvas = doc.backdrop ? composeBackdrop(flat, doc.backdrop) : flat;
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error("could not encode the image");
  return new Uint8Array(await blob.arrayBuffer());
}
