import type { Annotations, Point, Rect, Shape, Style, Tool } from "./model";

/** Shapes smaller than this many pixels are treated as a stray click. */
export const MIN_SIZE = 3;
export const HIGHLIGHTER_WIDTH = 18;
export const DEFAULT_PIXEL_SIZE = 12;

let nextId = 0;
export function newId(): string {
  nextId += 1;
  return `s${Date.now().toString(36)}${nextId.toString(36)}`;
}

export function normalizeRect(rect: Rect): Rect {
  return {
    x: Math.min(rect.x, rect.x + rect.width),
    y: Math.min(rect.y, rect.y + rect.height),
    width: Math.abs(rect.width),
    height: Math.abs(rect.height),
  };
}

/** Starts a shape where a drag begins. Text and crop are handled by the editor. */
export function beginShape(tool: Tool, at: Point, style: Style, id = newId()): Shape | null {
  const { color, strokeWidth } = style;
  switch (tool) {
    case "arrow":
    case "line":
      return { id, type: tool, color, strokeWidth, points: [at.x, at.y, at.x, at.y] };
    case "freehand":
      return { id, type: "freehand", color, strokeWidth, points: [at.x, at.y] };
    case "highlighter":
      return { id, type: "highlighter", color, strokeWidth: Math.max(HIGHLIGHTER_WIDTH, strokeWidth * 3), points: [at.x, at.y] };
    case "rect":
    case "ellipse":
      return { id, type: tool, color, strokeWidth, x: at.x, y: at.y, width: 0, height: 0 };
    case "blur":
      return { id, type: "blur", x: at.x, y: at.y, width: 0, height: 0, pixelSize: DEFAULT_PIXEL_SIZE };
    case "step":
      return { id, type: "step", color, x: at.x, y: at.y, radius: 12 + strokeWidth * 2 };
    default:
      return null;
  }
}

/** Updates a shape being drawn as the pointer moves to `to`. */
export function dragShape(shape: Shape, to: Point): Shape {
  switch (shape.type) {
    case "arrow":
    case "line":
      return { ...shape, points: [shape.points[0], shape.points[1], to.x, to.y] };
    case "freehand":
    case "highlighter":
      return { ...shape, points: [...shape.points, to.x, to.y] };
    case "rect":
    case "ellipse":
    case "blur":
      return { ...shape, width: to.x - shape.x, height: to.y - shape.y };
    default:
      return shape;
  }
}

/** Ends a drawing: normalises boxes and drops shapes too small to see. */
export function finishShape(shape: Shape): Shape | null {
  switch (shape.type) {
    case "arrow":
    case "line": {
      const [x1, y1, x2, y2] = shape.points;
      return Math.hypot(x2 - x1, y2 - y1) < MIN_SIZE ? null : shape;
    }
    case "freehand":
    case "highlighter":
      // A click leaves a dot.
      return shape.points.length === 2 ? { ...shape, points: [...shape.points, shape.points[0] + 0.5, shape.points[1]] } : shape;
    case "rect":
    case "ellipse":
    case "blur": {
      const rect = normalizeRect(shape);
      return rect.width < MIN_SIZE || rect.height < MIN_SIZE ? null : { ...shape, ...rect };
    }
    default:
      return shape;
  }
}

/** A finished crop drag, clipped to the image, or null for a stray click. */
export function cropFromDrag(start: Point, end: Point, image: { width: number; height: number }): Rect | null {
  const rect = normalizeRect({ x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y });
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(image.width, Math.round(rect.x + rect.width));
  const bottom = Math.min(image.height, Math.round(rect.y + rect.height));
  if (right - x < MIN_SIZE || bottom - y < MIN_SIZE) return null;
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Applies a Konva drag or resize. `x`/`y` are the node's new position and
 * `scaleX`/`scaleY` its scale; nodes are drawn at the shape's position
 * (point shapes at 0, 0), so both reduce to one mapping.
 */
export interface NodeTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

export function transformShape(shape: Shape, t: NodeTransform): Shape {
  switch (shape.type) {
    case "arrow":
    case "line":
    case "freehand":
    case "highlighter":
      return {
        ...shape,
        points: shape.points.map((value, i) => (i % 2 === 0 ? t.x + value * t.scaleX : t.y + value * t.scaleY)),
      };
    case "rect":
    case "ellipse":
    case "blur":
      return {
        ...shape,
        ...normalizeRect({ x: t.x, y: t.y, width: shape.width * t.scaleX, height: shape.height * t.scaleY }),
      };
    case "text":
      return { ...shape, x: t.x, y: t.y, fontSize: Math.max(6, shape.fontSize * Math.abs(t.scaleY)) };
    case "step":
      return { ...shape, x: t.x, y: t.y, radius: Math.max(6, shape.radius * Math.abs(t.scaleX)) };
  }
}

/** Moves a shape by dx, dy. */
export function moveShape(shape: Shape, dx: number, dy: number): Shape {
  if ("points" in shape) return transformShape(shape, { x: dx, y: dy, scaleX: 1, scaleY: 1 });
  return transformShape(shape, { x: shape.x + dx, y: shape.y + dy, scaleX: 1, scaleY: 1 });
}

/** Step badge numbers: 1, 2, 3... in the order the steps were added. */
export function stepNumbers(shapes: Shape[]): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const shape of shapes) {
    if (shape.type === "step") numbers.set(shape.id, numbers.size + 1);
  }
  return numbers;
}

/** Recolours a shape; blur has no colour. Stroke width applies to stroked shapes. */
export function restyleShape(shape: Shape, style: Partial<{ color: string; strokeWidth: number }>): Shape {
  if (shape.type === "blur") return shape;
  const next = { ...shape, ...(style.color ? { color: style.color } : {}) };
  if (style.strokeWidth && "strokeWidth" in next && next.type !== "highlighter") {
    return { ...next, strokeWidth: style.strokeWidth };
  }
  return next;
}

export function addShape(doc: Annotations, shape: Shape): Annotations {
  return { ...doc, shapes: [...doc.shapes, shape] };
}

export function replaceShape(doc: Annotations, shape: Shape): Annotations {
  return { ...doc, shapes: doc.shapes.map((old) => (old.id === shape.id ? shape : old)) };
}

export function deleteShape(doc: Annotations, id: string): Annotations {
  return { ...doc, shapes: doc.shapes.filter((shape) => shape.id !== id) };
}
