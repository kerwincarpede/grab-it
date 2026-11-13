import type { Annotations, Backdrop, Rect, Shape } from "./model";
import { BACKDROP_MAX_PADDING, BACKDROP_MAX_RADIUS, emptyAnnotations } from "./model";

export class SidecarError extends Error {}

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isStr = (value: unknown): value is string => typeof value === "string";
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
/** Fields added after the first release are optional, so old sidecars still load. */
const isOptional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
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
      return stroked && isRect(shape) && isOptional(shape.fill, isBool);
    case "blur":
      return (
        isRect(shape) &&
        isNum(shape.pixelSize) &&
        isOptional(shape.mode, (mode) => mode === "pixelate" || mode === "blur")
      );
    case "spotlight":
      return isRect(shape);
    case "text":
      return (
        isStr(shape.color) &&
        isNum(shape.x) &&
        isNum(shape.y) &&
        isStr(shape.text) &&
        isNum(shape.fontSize) &&
        isOptional(shape.background, isBool)
      );
    case "step":
      return isStr(shape.color) && isNum(shape.x) && isNum(shape.y) && isNum(shape.radius);
    default:
      return false;
  }
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

/** A well-formed backdrop with its sizes in range, or null (no backdrop). */
export function parseBackdrop(value: unknown): Backdrop | null {
  if (typeof value !== "object" || value === null) return null;
  const backdrop = value as Record<string, unknown>;
  if (!isStr(backdrop.fill) || !isNum(backdrop.padding) || !isNum(backdrop.radius) || !isBool(backdrop.shadow)) return null;
  return {
    fill: backdrop.fill,
    padding: clamp(backdrop.padding, BACKDROP_MAX_PADDING),
    radius: clamp(backdrop.radius, BACKDROP_MAX_RADIUS),
    shadow: backdrop.shadow,
  };
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
  const backdrop = parseBackdrop(doc.backdrop);
  return {
    version: 1,
    shapes: doc.shapes.filter(isShape),
    crop: crop && typeof crop === "object" && isRect(crop) ? (crop as unknown as Rect) : null,
    ...(backdrop ? { backdrop } : {}),
  };
}

/**
 * The JSON written to `<capture>.annotations.json`. `backdrop` is written
 * only when set, so a capture without one keeps the original layout.
 */
export function serializeAnnotations(doc: Annotations): Annotations {
  return { version: 1, shapes: doc.shapes, crop: doc.crop ?? null, ...(doc.backdrop ? { backdrop: doc.backdrop } : {}) };
}
