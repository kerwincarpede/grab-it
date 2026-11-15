import { backdropLayout, backdropPaint, paintBackdrop, roundedRectPath, type BackdropSources } from "../editor/flatten";
import type { Backdrop } from "../editor/model";

/** The longest side an export may have, so 9:16 of a full-HD recording is 1080 × 1920. */
export const MAX_EXPORT_SIDE = 1920;

/** Where the video goes in the export, in output pixels. */
export interface VideoLayout {
  /** The output's size, even both ways as H.264 needs. */
  width: number;
  height: number;
  /** The video's top-left corner and the size it takes there. */
  x: number;
  y: number;
  videoWidth: number;
  videoHeight: number;
  /** The video's corner radius. */
  radius: number;
  shadow: { blur: number; offsetY: number; opacity: number } | null;
}

/** The nearest even size, at least 2. */
const even = (side: number) => Math.max(2, Math.round(side / 2) * 2);

/**
 * Lays a `video`-sized recording out on its backdrop as captures are laid
 * out (`backdropLayout`: padding, then the aspect ratio), radius in pixels,
 * then scales the whole so its longer side is at most `MAX_EXPORT_SIDE`
 * and rounds the output to even sizes. Without a backdrop the video is the
 * output, scaled the same way.
 */
export function recordingLayout(video: { width: number; height: number }, backdrop: Backdrop | null | undefined): VideoLayout {
  const base = backdropLayout(video, backdrop);
  const fit = Math.min(1, MAX_EXPORT_SIDE / Math.max(1, base.width, base.height));
  const width = even(base.width * fit);
  const height = even(base.height * fit);
  if (!backdrop) {
    return { width, height, x: 0, y: 0, videoWidth: width, videoHeight: height, radius: 0, shadow: null };
  }
  const x = Math.min(Math.round(base.x * fit), width - 1);
  const y = Math.min(Math.round(base.y * fit), height - 1);
  const videoWidth = Math.max(1, Math.min(Math.round(video.width * fit), width - x));
  const videoHeight = Math.max(1, Math.min(Math.round(video.height * fit), height - y));
  const shadow = base.shadow && {
    blur: Math.round(base.shadow.blur * fit),
    offsetY: Math.round(base.shadow.offsetY * fit),
    opacity: base.shadow.opacity,
  };
  return { width, height, x, y, videoWidth, videoHeight, radius: base.radius * fit, shadow };
}

type FrameContext = Pick<
  CanvasRenderingContext2D,
  | "fillStyle"
  | "fillRect"
  | "createLinearGradient"
  | "createRadialGradient"
  | "drawImage"
  | "save"
  | "restore"
  | "beginPath"
  | "fill"
  | "moveTo"
  | "lineTo"
  | "arcTo"
  | "closePath"
  | "shadowColor"
  | "shadowBlur"
  | "shadowOffsetY"
>;

/**
 * Paints what lies under the video: black (a video has no transparency),
 * the backdrop's fill as captures paint it, and the shadow, cast by an
 * opaque plate where the video will go. Shared by the preview and the
 * export, so they match.
 */
export function paintUnderlay(ctx: FrameContext, layout: VideoLayout, backdrop: Backdrop, sources: BackdropSources): void {
  const size = { width: layout.width, height: layout.height };
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, size.width, size.height);
  paintBackdrop(ctx, backdropPaint(backdrop, size), size, sources);
  if (!layout.shadow) return;
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${layout.shadow.opacity})`;
  ctx.shadowBlur = layout.shadow.blur;
  ctx.shadowOffsetY = layout.shadow.offsetY;
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  roundedRectPath(ctx, videoRect(layout), layout.radius);
  ctx.fill();
  ctx.restore();
}

/** The video's place in the output. */
export function videoRect(layout: VideoLayout) {
  return { x: layout.x, y: layout.y, width: layout.videoWidth, height: layout.videoHeight };
}

/** Paints the video's rounded rectangle opaque on a clear canvas: how much of the video shows at each pixel. */
export function paintMask(ctx: Pick<CanvasRenderingContext2D, "fillStyle" | "beginPath" | "fill" | "moveTo" | "lineTo" | "arcTo" | "closePath">, layout: VideoLayout): void {
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  roundedRectPath(ctx, videoRect(layout), layout.radius);
  ctx.fill();
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not draw the backdrop");
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasOf(layout: VideoLayout): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not draw the backdrop");
  return { canvas, ctx };
}

/** The backdrop and mask PNGs the export composes every frame onto. */
export async function exportLayers(layout: VideoLayout, backdrop: Backdrop, sources: BackdropSources): Promise<{ backdrop: Uint8Array; mask: Uint8Array }> {
  const under = canvasOf(layout);
  paintUnderlay(under.ctx, layout, backdrop, sources);
  const mask = canvasOf(layout);
  paintMask(mask.ctx, layout);
  return { backdrop: await canvasPng(under.canvas), mask: await canvasPng(mask.canvas) };
}
