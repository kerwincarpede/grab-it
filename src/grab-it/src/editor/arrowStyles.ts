import type { ElbowRoute, LineShape, Point } from "./model";

export const ARROW_STYLE_GROUPS = [
  { label: "Pointers", styles: [
    { id: "classic", label: "Classic" },
    { id: "open", label: "Open" },
    { id: "needle", label: "Needle" },
    { id: "dot-tail", label: "Dot tail" },
  ] },
  { label: "Emphasis", styles: [
    { id: "block", label: "Block" },
    { id: "outline", label: "Outline" },
    { id: "tapered", label: "Tapered" },
    { id: "dashed", label: "Dashed" },
  ] },
  { label: "Ranges and flow", styles: [
    { id: "double-ended", label: "Double-ended" },
    { id: "capped", label: "Capped" },
    { id: "elbow", label: "Elbow" },
    { id: "chevron-trail", label: "Chevron trail" },
  ] },
] as const;

export type ArrowStyle = (typeof ARROW_STYLE_GROUPS)[number]["styles"][number]["id"];

export const ARROW_STYLES = ARROW_STYLE_GROUPS.flatMap(({ styles }) => [...styles]);

export function arrowStyle(value: unknown): ArrowStyle {
  return ARROW_STYLES.find(({ id }) => id === value)?.id ?? "classic";
}

const add = (a: Point, b: Point, scale = 1): Point => ({ x: a.x + b.x * scale, y: a.y + b.y * scale });
const between = (a: Point, b: Point): Point => ({ x: b.x - a.x, y: b.y - a.y });
const mix = (a: Point, b: Point, t: number): Point => add(a, between(a, b), t);
const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

function unit(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  return length > 0 ? { x: vector.x / length, y: vector.y / length } : { x: 1, y: 0 };
}

const normal = ({ x, y }: Point): Point => ({ x: -y, y: x });
const pair = ({ x, y }: Point): string => `${x} ${y}`;
const polyline = (points: Point[]): string => `M ${points.map(pair).join(" L ")}`;
const polygon = (points: Point[]): string => `${polyline(points)} Z`;

function endpoints({ points: [x1, y1, x2, y2] }: LineShape): [Point, Point] {
  return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
}

export function isElbow(shape: LineShape): boolean {
  return shape.type === "arrow" && shape.arrowStyle === "elbow";
}

export function elbowRoute(shape: LineShape): ElbowRoute {
  const [start, end] = endpoints(shape);
  // Even with level endpoints, the middle handle can pull the route off the baseline.
  const axis = Math.abs(end.y - start.y) >= Math.abs(end.x - start.x) ? "x" : "y";
  return shape.elbow ?? { axis, at: (start[axis] + end[axis]) / 2 };
}

function elbowPoints(shape: LineShape): Point[] {
  const [start, end] = endpoints(shape);
  const { axis, at } = elbowRoute(shape);
  return [start, { ...start, [axis]: at }, { ...end, [axis]: at }, end];
}

export function elbowMidpoint(shape: LineShape): Point {
  const [, first, second] = elbowPoints(shape);
  return mix(first, second, 0.5);
}

export function bendElbow(shape: LineShape, handle: Point): LineShape {
  const { axis, at } = elbowRoute(shape);
  return handle[axis] === at ? shape : { ...shape, elbow: { axis, at: handle[axis] } };
}

interface Sample {
  point: Point;
  tangent: Point;
}

interface Shaft {
  length: number;
  endRun: number;
  sample: (distance: number) => Sample;
  path: (from: number, to: number) => string;
}

function straightShaft(points: Point[]): Shaft {
  const segments = points.slice(1).flatMap((end, index) => {
    const start = points[index];
    const length = distance(start, end);
    return length > 0 ? [{ start, end, length, tangent: unit(between(start, end)) }] : [];
  });
  let length = 0;
  const stops = segments.map((segment) => (length += segment.length));
  const sample = (at: number): Sample => {
    const index = stops.findIndex((stop) => at <= stop);
    const segment = segments[index === -1 ? segments.length - 1 : index];
    if (!segment) return { point: points[0], tangent: { x: 1, y: 0 } };
    if (at >= length) return { point: segment.end, tangent: segment.tangent };
    const start = stops[index - 1] ?? 0;
    return { point: mix(segment.start, segment.end, (at - start) / segment.length), tangent: segment.tangent };
  };
  return {
    length,
    endRun: segments[segments.length - 1]?.length ?? 0,
    sample,
    path: (from, to) => polyline([
      sample(from).point,
      ...stops.flatMap((stop, index) => stop > from && stop < to ? [segments[index].end] : []),
      sample(to).point,
    ]),
  };
}

/** Approximate arc length for fitting details; the path itself stays quadratic. */
function curvedShaft(start: Point, control: Point, end: Point): Shaft {
  const at = (t: number) => mix(mix(start, control, t), mix(control, end, t), t);
  const tangent = (t: number) => between(mix(start, control, t), mix(control, end, t));
  const steps = 24;
  const stops = [0];
  for (let i = 1; i <= steps; i++) stops.push(stops[i - 1] + distance(at((i - 1) / steps), at(i / steps)));
  const length = stops[steps];
  const time = (offset: number) => {
    if (offset <= 0) return 0;
    if (offset >= length) return 1;
    const i = stops.findIndex((stop) => stop >= offset);
    return (i - 1 + (offset - stops[i - 1]) / (stops[i] - stops[i - 1])) / steps;
  };
  return {
    length,
    endRun: length,
    sample: (offset) => {
      const t = time(offset);
      const vector = tangent(t);
      return { point: at(t), tangent: unit(vector.x || vector.y ? vector : between(start, end)) };
    },
    path: (from, to) => {
      const t = time(from);
      const start = at(t);
      const end = time(to);
      const handle = add(start, tangent(t), end - t);
      return `M ${pair(start)} Q ${pair(handle)} ${pair(at(end))}`;
    },
  };
}

export interface ArrowPart {
  path: string;
  /** A missing width indicates a filled path. */
  strokeWidth?: number;
}

export interface ArrowGeometry {
  parts: ArrowPart[];
  /** The centreline also makes the gaps in dashed arrows easy to grab. */
  centreline: string;
}

function head(tip: Point, aim: Point, length: number, halfWidth: number): [Point, Point, Point] {
  const base = add(tip, aim, -length);
  const side = normal(aim);
  return [add(base, side, halfWidth), tip, add(base, side, -halfWidth)];
}

/** The sides of a wide arrow. Connect them to the head to keep Outline hollow. */
function silhouette(shaft: Shaft, tip: Sample, headLength: number, halfHead: number, startWidth: number, endWidth: number): string {
  const along = Math.max(0, shaft.length - headLength);
  const [leftHead, point, rightHead] = head(tip.point, tip.tangent, headLength, halfHead);
  const base = add(tip.point, tip.tangent, -headLength);
  const endNormal = normal(tip.tangent);
  const left: Point[] = [];
  const right: Point[] = [];
  // A cubic or quadratic offset is not itself a quadratic. Sample the
  // centreline and taper the sides along its length.
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const sample = shaft.sample(along * t);
    const half = (startWidth + (endWidth - startWidth) * t) / 2;
    left.push(add(sample.point, normal(sample.tangent), half));
    right.push(add(sample.point, normal(sample.tangent), -half));
  }
  return polygon([
    ...left, add(base, endNormal, endWidth / 2), leftHead, point, rightHead,
    add(base, endNormal, -endWidth / 2), ...right.reverse(),
  ]);
}

/** Shared path data for SVG picker previews and the Konva canvas and exports. */
export function arrowGeometry(shape: LineShape): ArrowGeometry {
  const style = arrowStyle(shape.arrowStyle);
  const [start, end] = endpoints(shape);
  const shaft = isElbow(shape)
    ? straightShaft(elbowPoints(shape))
    : shape.control
      ? curvedShaft(start, { x: shape.control[0], y: shape.control[1] }, end)
      : straightShaft([start, end]);
  const { length, endRun, sample, path } = shaft;
  if (length === 0) return { parts: [], centreline: "" };
  const width = Math.max(0, Math.min(shape.strokeWidth, length / 5));
  const headSize = width * 3 + 6;
  const fit = (size: number, fraction: number) => Math.min(size, length * fraction, endRun);
  const tail = sample(0);
  const tip = sample(length);
  const parts: ArrowPart[] = [];
  const stroke = (data: string, strokeWidth = width) => parts.push({ path: data, strokeWidth });
  const fill = (data: string) => parts.push({ path: data });
  const triangle = (sample: Sample, aim: Point, size: number, halfWidth: number) => fill(polygon(head(sample.point, aim, size, halfWidth)));
  const centreline = path(0, length);

  if (style === "open" || style === "chevron-trail") {
    const trail = style === "chevron-trail";
    const size = fit(headSize * 0.75, trail ? 0.24 : 0.37);
    const offset = size * 1.05;
    const first = trail ? sample(length - offset) : tip;
    stroke(path(0, length - (trail ? offset : 0)));
    stroke(polyline(head(tip.point, tip.tangent, size, size * 0.56)));
    if (trail) stroke(polyline(head(first.point, first.tangent, size, size * 0.56)));
  } else if (style === "block" || style === "outline" || style === "tapered") {
    const tapered = style === "tapered";
    const size = fit(headSize * (tapered ? 1 : 1.35), 0.42);
    const halfHead = size * 0.62;
    const broad = Math.min(width * 2.5 + 2, halfHead * 1.2);
    const data = silhouette(shaft, tip, size, halfHead, tapered ? broad * 0.23 : broad, broad);
    if (style === "outline") stroke(data, Math.min(width * 0.65, broad * 0.4));
    else fill(data);
  } else {
    const needle = style === "needle";
    const twice = style === "double-ended";
    const size = fit(headSize * (needle ? 1.3 : 1), twice ? 0.29 : 0.45);
    const half = Math.min(size * (needle ? 0.24 : 0.5), headSize / 2);
    // On a tight bend the point at a fixed arc distance can lie outside
    // the triangle, or even on its opposite side. Draw the curve through
    // the tip so the shaft stays attached when the end doubles back.
    const trim = shape.control && !isElbow(shape) ? 0 : size * 0.7;
    const from = twice ? trim : 0;
    const to = length - trim;
    if (style === "dashed") {
      const count = Math.max(2, Math.min(100, Math.round(to / Math.max(6, width * 4))));
      const spacing = to / count;
      for (let i = 0; i < count; i++) {
        stroke(path((i + 0.42) * spacing, (i + 1) * spacing), Math.min(width, spacing * 0.25));
      }
    } else {
      stroke(path(from, to), needle ? width * 0.55 : width);
    }
    if (twice) triangle(tail, { x: -tail.tangent.x, y: -tail.tangent.y }, size, half);
    if (style === "dot-tail") {
      const radius = Math.min(width * 1.4 + 1, length * 0.16);
      fill(`M ${tail.point.x - radius} ${tail.point.y} a ${radius} ${radius} 0 1 0 ${2 * radius} 0 a ${radius} ${radius} 0 1 0 ${-2 * radius} 0 Z`);
    }
    if (style === "capped") {
      const side = normal(tail.tangent);
      const cap = Math.min(width + 2, length * 0.15);
      stroke(polyline([add(tail.point, side, -cap), add(tail.point, side, cap)]));
    }
    triangle(tip, tip.tangent, size, half);
  }
  return { parts, centreline };
}
