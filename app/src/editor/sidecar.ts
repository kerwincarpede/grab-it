import type { Annotations, Rect, Shape } from "./model";
import { emptyAnnotations } from "./model";

export class SidecarError extends Error {}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const isPoints = (value: unknown, min: number): value is number[] =>
  Array.isArray(value) && value.length >= min && value.length % 2 === 0 && value.every(isNum);

function isRect(value: Record<string, unknown>): boolean {
  return isNum(value.x) && isNum(value.y) && isNum(value.width) && isNum(value.height);
}

/** True when `value` is a shape this version can draw. */
export function isShape(value: unknown): value is Shape {
  if (typeof value !== "object" || value === null) return false;
  const shape = value as Record<string, unknown>;
  if (!isStr(shape.id)) return false;
  const stroked = isStr(shape.color) && isNum(shape.strokeWidth);
  switch (shape.type) {
    case "arrow":
    case "line":
      return stroked && isPoints(shape.points, 4);
    case "freehand":
    case "highlighter":
      return stroked && isPoints(shape.points, 2);
    case "rect":
    case "ellipse":
      return stroked && isRect(shape);
    case "blur":
      return isRect(shape) && isNum(shape.pixelSize);
    case "text":
      return isStr(shape.color) && isNum(shape.x) && isNum(shape.y) && isStr(shape.text) && isNum(shape.fontSize);
    case "step":
      return isStr(shape.color) && isNum(shape.x) && isNum(shape.y) && isNum(shape.radius);
    default:
      return false;
  }
}

/**
 * Reads a sidecar. `null` or `undefined` (no sidecar yet) gives an empty
 * document. An unknown version throws, so it is never overwritten; unknown
 * shapes inside a v1 sidecar are skipped.
 */
export function parseAnnotations(value: unknown): Annotations {
  if (value === null || value === undefined) return emptyAnnotations();
  if (typeof value !== "object") throw new SidecarError("annotations are not an object");
  const doc = value as Record<string, unknown>;
  if (doc.version !== 1) throw new SidecarError(`unsupported annotations version ${String(doc.version)}`);
  if (!Array.isArray(doc.shapes)) throw new SidecarError("annotations need a shapes list");
  const crop = doc.crop as Record<string, unknown> | null | undefined;
  return {
    version: 1,
    shapes: doc.shapes.filter(isShape),
    crop: crop && typeof crop === "object" && isRect(crop) ? (crop as unknown as Rect) : null,
  };
}

/** The JSON written to `<capture>.annotations.json`. */
export function serializeAnnotations(doc: Annotations): Annotations {
  return { version: 1, shapes: doc.shapes, crop: doc.crop ?? null };
}
