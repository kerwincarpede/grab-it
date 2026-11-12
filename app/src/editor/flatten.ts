import type Konva from "konva";
import type { Rect } from "./model";

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

/**
 * Renders the capture and its annotations (the content layer only, never
 * the selection handles) at capture resolution, cropped.
 */
export async function flatten(
  layer: Konva.Layer,
  crop: Rect | null | undefined,
  image: { width: number; height: number },
  view: View,
  format: ExportFormat,
): Promise<Uint8Array> {
  const canvas = layer.toCanvas(exportArea(crop, image, view));
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, 0.92));
  if (!blob) throw new Error("could not encode the image");
  return new Uint8Array(await blob.arrayBuffer());
}
