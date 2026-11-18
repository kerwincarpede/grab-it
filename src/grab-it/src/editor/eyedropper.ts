import { toHex } from "../overlay/geometry";
import type { Point } from "./model";

/** The capture pixel at `at` (capture pixels), or null when `at` is off the capture. */
export function capturePixel(at: Point, size: { width: number; height: number }): Point | null {
  const x = Math.floor(at.x);
  const y = Math.floor(at.y);
  if (x < 0 || y < 0 || x >= size.width || y >= size.height) return null;
  return { x, y };
}

/**
 * The colour of one capture pixel as `#rrggbb`, read as the overlay's loupe
 * reads it; null where canvas cannot be read (jsdom, a tainted image).
 */
export function pixelColor(image: CanvasImageSource, pixel: Point): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, pixel.x, pixel.y, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return toHex(red, green, blue).toLowerCase();
  } catch {
    return null;
  }
}
