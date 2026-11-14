import type Konva from "konva";
import {
  BACKDROP_ASPECTS,
  BACKDROP_FILLS,
  BACKDROP_MESHES,
  backdropColors,
  DEFAULT_GRADIENT,
  DEFAULT_SHADOW_SIZE,
  DEFAULT_SHADOW_STRENGTH,
  type Backdrop,
  type BackdropAspect,
  type Point,
  type Rect,
} from "./model";

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
  /** The capture's corner radius in pixels, never more than half its shorter side. */
  radius: number;
  shadow: { blur: number; offsetY: number; opacity: number } | null;
}

/** Image pixels per point when a capture does not say: the editor window's own density. */
export function fallbackScale(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** The output ratio (width / height) an aspect asks for, or null to pad evenly. */
export function aspectRatio(aspect: BackdropAspect | undefined): number | null {
  return BACKDROP_ASPECTS.find((entry) => entry.aspect === aspect)?.ratio ?? null;
}

/**
 * Lays a capture of `size` out on its backdrop: the output grows by the
 * padding on every side, then by more on one axis to reach the aspect
 * ratio, with the capture centred. The radius is in points, so `scale`
 * (image pixels per point) turns it into pixels. Without a backdrop the
 * capture is the output.
 *
 * The editor's preview and the export compose both lay out with this, so
 * they always agree.
 */
export function backdropLayout(
  size: { width: number; height: number },
  backdrop: Backdrop | null | undefined,
  scale = 1,
): BackdropLayout {
  if (!backdrop) return { width: size.width, height: size.height, x: 0, y: 0, radius: 0, shadow: null };
  // Whole pixels, so the capture is not resampled.
  const padding = Math.max(0, Math.round(backdrop.padding));
  let width = size.width + padding * 2;
  let height = size.height + padding * 2;
  const ratio = aspectRatio(backdrop.aspect);
  if (ratio !== null && height > 0) {
    if (width / height < ratio) width = Math.round(height * ratio);
    else if (width / height > ratio) height = Math.round(width / ratio);
  }
  const shorter = Math.min(size.width, size.height);
  const pixelsPerPoint = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return {
    width,
    height,
    x: Math.round((width - size.width) / 2),
    y: Math.round((height - size.height) / 2),
    radius: Math.max(0, Math.min(backdrop.radius * pixelsPerPoint, shorter / 2)),
    shadow: backdropShadow(backdrop, shorter),
  };
}

/**
 * The shadow under the capture. At the default size and strength (and for
 * sidecars from before the sliders) this is the shadow backdrops always
 * had: a blur of 6% of the capture's shorter side, at least 12px, a third
 * of that down, at 35% black.
 */
export function backdropShadow(backdrop: Backdrop, shorter: number): BackdropLayout["shadow"] {
  const strength = backdrop.shadowStrength ?? DEFAULT_SHADOW_STRENGTH;
  if (!backdrop.shadow || strength <= 0) return null;
  const size = backdrop.shadowSize ?? DEFAULT_SHADOW_SIZE;
  // The shadow scales with the capture, and stays visible on small ones.
  const blur = Math.round((Math.max(12, shorter * 0.06) * size) / DEFAULT_SHADOW_SIZE);
  return { blur, offsetY: Math.round(blur / 3), opacity: Math.min(1, strength / 100) };
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

/** The start and end of a CSS-style linear gradient at `angle` degrees across a `width` × `height` box. */
export function angleLine(angle: number, width: number, height: number): { start: Point; end: Point } {
  const radians = (angle * Math.PI) / 180;
  const dx = Math.sin(radians);
  const dy = -Math.cos(radians);
  // Long enough that the end colours reach the corners, as in CSS.
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  return {
    start: { x: width / 2 - dx * half, y: height / 2 - dy * half },
    end: { x: width / 2 + dx * half, y: height / 2 + dy * half },
  };
}

/**
 * One layer of a backdrop's fill, in output pixels from its top-left corner,
 * painted in order. Gradient stops are as Konva takes them.
 */
export type PaintLayer =
  | { kind: "solid"; color: string }
  | { kind: "linear"; start: Point; end: Point; stops: (number | string)[] }
  | { kind: "radial"; center: Point; radius: number; stops: (number | string)[] }
  /** The capture, covering the output, heavily blurred. */
  | { kind: "blurred" }
  /** The picked image, covering the output. */
  | { kind: "image" };

/** Shows under a blurred capture's soft edges, and in place of an image that cannot load. */
export const BACKDROP_UNDERLAY = "#8a919c";

/**
 * What a backdrop's fill paints over the whole output, as layers: a
 * gradient corner to corner for presets, a base colour with soft blobs
 * for meshes, nothing at all for transparent. Shared by the preview and
 * the export compose.
 */
export function backdropPaint(backdrop: Backdrop, size: { width: number; height: number }): PaintLayer[] {
  const { width, height } = size;
  switch (backdrop.fill) {
    case BACKDROP_FILLS.transparent:
      return [];
    case BACKDROP_FILLS.blur:
      return [{ kind: "solid", color: BACKDROP_UNDERLAY }, { kind: "blurred" }];
    case BACKDROP_FILLS.image:
      return [{ kind: "solid", color: BACKDROP_UNDERLAY }, { kind: "image" }];
    case BACKDROP_FILLS.custom: {
      const gradient = backdrop.gradient ?? DEFAULT_GRADIENT;
      return [{ kind: "linear", ...angleLine(gradient.angle, width, height), stops: gradientStops([gradient.from, gradient.to]) }];
    }
  }
  const mesh = BACKDROP_MESHES.find((entry) => entry.id === backdrop.fill);
  if (mesh) {
    const reach = Math.max(width, height);
    return [
      { kind: "solid", color: mesh.base },
      ...mesh.blobs.map(
        (blob): PaintLayer => ({
          kind: "radial",
          center: { x: blob.x * width, y: blob.y * height },
          radius: blob.radius * reach,
          // The blob fades out to its own colour, fully transparent.
          stops: [0, blob.color, 1, `${blob.color}00`],
        }),
      ),
    ];
  }
  const colors = backdropColors(backdrop.fill);
  if (colors.length > 1) return [{ kind: "linear", start: { x: 0, y: 0 }, end: { x: width, y: height }, stops: gradientStops(colors) }];
  return [{ kind: "solid", color: colors[0] }];
}

/**
 * The part of `source` (a rectangle of an image) that fills `target`
 * the way CSS `background-size: cover` does: scaled to cover it, centred,
 * the overflow cut off.
 */
export function coverCrop(source: Rect, target: { width: number; height: number }): Rect {
  const scale = Math.max(target.width / source.width, target.height / source.height);
  const width = target.width / scale;
  const height = target.height / scale;
  return { x: source.x + (source.width - width) / 2, y: source.y + (source.height - height) / 2, width, height };
}

/** The blurred capture is drawn this many pixels across its longer side, then stretched: the blur hides the low resolution. */
export const BLURRED_SIZE = 320;
/** The blur radius, as a share of the blurred image's longer side. */
const BLUR_AMOUNT = 0.05;

/**
 * How the blurred capture is drawn: `width` × `height` pixels with a blur
 * of `blur`, on a canvas `margin` larger on every side so the blur's soft
 * edges fall outside the part that is shown (`crop`).
 */
export function blurredGeometry(size: { width: number; height: number }) {
  const shrink = Math.min(1, BLURRED_SIZE / Math.max(1, size.width, size.height));
  const width = Math.max(1, Math.round(size.width * shrink));
  const height = Math.max(1, Math.round(size.height * shrink));
  const blur = Math.max(2, Math.round(Math.max(width, height) * BLUR_AMOUNT));
  const margin = blur * 2;
  return {
    blur,
    canvas: { width: width + margin * 2, height: height + margin * 2 },
    crop: { x: margin, y: margin, width, height },
  };
}

/**
 * The capture (the `area` of `source`) blurred for a backdrop of `size`.
 * Draw `crop` of the canvas stretched over the whole output. Null when
 * there is no canvas to draw on.
 */
export function blurredBackdrop(
  source: CanvasImageSource,
  area: Rect,
  size: { width: number; height: number },
): { canvas: HTMLCanvasElement; crop: Rect } | null {
  const geometry = blurredGeometry(size);
  const sharp = document.createElement("canvas");
  sharp.width = geometry.canvas.width;
  sharp.height = geometry.canvas.height;
  const sharpCtx = sharp.getContext("2d");
  if (!sharpCtx || area.width <= 0 || area.height <= 0) return null;
  const from = coverCrop(area, geometry.canvas);
  sharpCtx.drawImage(source, from.x, from.y, from.width, from.height, 0, 0, sharp.width, sharp.height);

  const canvas = document.createElement("canvas");
  canvas.width = sharp.width;
  canvas.height = sharp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  if (typeof ctx.filter === "string") {
    ctx.filter = `blur(${geometry.blur}px)`;
    ctx.drawImage(sharp, 0, 0);
    ctx.filter = "none";
  } else {
    // No canvas filters here: shrinking hard and stretching back blurs too.
    const tiny = document.createElement("canvas");
    tiny.width = Math.max(1, Math.round(sharp.width / geometry.blur));
    tiny.height = Math.max(1, Math.round(sharp.height / geometry.blur));
    const tinyCtx = tiny.getContext("2d");
    if (!tinyCtx) return null;
    tinyCtx.imageSmoothingQuality = "high";
    tinyCtx.drawImage(sharp, 0, 0, tiny.width, tiny.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tiny, 0, 0, canvas.width, canvas.height);
  }
  return { canvas, crop: geometry.crop };
}

/** What the blurred and image fills draw from. */
export interface BackdropSources {
  /** The capture and the area of it that is exported, for the blurred fill. */
  capture?: { image: CanvasImageSource; area: Rect } | null;
  /** The picked image, once loaded, for the image fill. */
  image?: HTMLImageElement | null;
}

type PaintContext = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "fillRect" | "createLinearGradient" | "createRadialGradient" | "drawImage"
>;

/** Paints a backdrop's layers over a `size` output on a canvas. */
export function paintBackdrop(ctx: PaintContext, layers: PaintLayer[], size: { width: number; height: number }, sources: BackdropSources): void {
  const addStops = (gradient: CanvasGradient, stops: (number | string)[]) => {
    for (let i = 0; i < stops.length; i += 2) gradient.addColorStop(stops[i] as number, stops[i + 1] as string);
    return gradient;
  };
  for (const layer of layers) {
    switch (layer.kind) {
      case "solid":
        ctx.fillStyle = layer.color;
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      case "linear":
        ctx.fillStyle = addStops(ctx.createLinearGradient(layer.start.x, layer.start.y, layer.end.x, layer.end.y), layer.stops);
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      case "radial":
        ctx.fillStyle = addStops(ctx.createRadialGradient(layer.center.x, layer.center.y, 0, layer.center.x, layer.center.y, layer.radius), layer.stops);
        ctx.fillRect(0, 0, size.width, size.height);
        break;
      case "blurred": {
        const blurred = sources.capture ? blurredBackdrop(sources.capture.image, sources.capture.area, size) : null;
        if (blurred) {
          const { crop } = blurred;
          ctx.drawImage(blurred.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, size.width, size.height);
        }
        break;
      }
      case "image": {
        const image = sources.image;
        if (image && image.width > 0 && image.height > 0) {
          const from = coverCrop({ x: 0, y: 0, width: image.width, height: image.height }, size);
          ctx.drawImage(image, from.x, from.y, from.width, from.height, 0, 0, size.width, size.height);
        }
        break;
      }
    }
  }
}

/** How to draw a backdrop: the capture's pixels per point, and what the blurred and image fills draw from. */
export interface ComposeOptions extends BackdropSources {
  scale?: number;
}

/** Draws the flattened capture on its backdrop: fill, shadow, then the capture with rounded corners. */
export function composeBackdrop(source: HTMLCanvasElement, backdrop: Backdrop, options: ComposeOptions = {}): HTMLCanvasElement {
  const layout = backdropLayout({ width: source.width, height: source.height }, backdrop, options.scale);
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not draw the backdrop");

  // Without the capture itself, the blurred fill blurs what is exported.
  const capture = options.capture ?? { image: source, area: { x: 0, y: 0, width: source.width, height: source.height } };
  paintBackdrop(ctx, backdropPaint(backdrop, layout), layout, { capture, image: options.image });

  const place = { x: layout.x, y: layout.y, width: source.width, height: source.height };
  if (layout.shadow) {
    // An opaque plate the size of the capture casts the shadow; the capture covers it.
    ctx.save();
    ctx.shadowColor = `rgba(0, 0, 0, ${layout.shadow.opacity})`;
    ctx.shadowBlur = layout.shadow.blur;
    ctx.shadowOffsetY = layout.shadow.offsetY;
    ctx.fillStyle = "#000000";
    ctx.beginPath();
    roundedRectPath(ctx, place, layout.radius);
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.beginPath();
  roundedRectPath(ctx, place, layout.radius);
  ctx.clip();
  ctx.drawImage(source, layout.x, layout.y);
  ctx.restore();
  return canvas;
}

/** JPEG has no transparency: what is see-through becomes white, not black. */
export function onWhite(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return source;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);
  return canvas;
}

/**
 * Renders the capture and its annotations (the content layer only, never
 * the selection handles) at capture resolution, cropped, then framed by the
 * backdrop when there is one. A transparent backdrop stays transparent in
 * a PNG.
 */
export async function flatten(
  layer: Konva.Layer,
  doc: { crop?: Rect | null; backdrop?: Backdrop | null },
  image: { width: number; height: number },
  view: View,
  format: ExportFormat,
  options: ComposeOptions = {},
): Promise<Uint8Array> {
  const flat = layer.toCanvas(exportArea(doc.crop, image, view));
  const framed = doc.backdrop ? composeBackdrop(flat, doc.backdrop, options) : flat;
  const canvas = format === "jpg" ? onWhite(framed) : framed;
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error("could not encode the image");
  return new Uint8Array(await blob.arrayBuffer());
}
