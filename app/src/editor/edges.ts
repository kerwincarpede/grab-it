import { toDisplay, type Orientation } from "./orient";

/** RGBA pixels, four bytes each, row by row: the shape of `ImageData`. */
export interface Pixels {
  width: number;
  height: number;
  data: ArrayLike<number>;
}

/** Strong lines in a capture, in capture pixels: `x` are vertical lines, `y` horizontal ones, each ascending. */
export interface Edges {
  x: number[];
  y: number[];
}

/** Edges are looked for on a copy at most this many pixels on its long side. */
export const EDGE_SCAN_SIZE = 512;
/** Gray levels (0–255) a pixel must step by from its neighbour to count. */
export const EDGE_STEP = 32;
/** The share of a column (or row) that must step for it to be a line. */
export const EDGE_SHARE = 0.3;

/** No lines at all. */
export const NO_EDGES: Edges = { x: [], y: [] };

/** A grayscale copy of `pixels` at most `EDGE_SCAN_SIZE` on its long side, each cell the average of the pixels it covers. */
function grayscale(pixels: Pixels): { width: number; height: number; gray: Float32Array } {
  const factor = Math.max(1, Math.max(pixels.width, pixels.height) / EDGE_SCAN_SIZE);
  const width = Math.max(1, Math.round(pixels.width / factor));
  const height = Math.max(1, Math.round(pixels.height / factor));
  const sums = new Float32Array(width * height);
  const counts = new Uint32Array(width * height);
  for (let y = 0; y < pixels.height; y += 1) {
    const row = Math.min(height - 1, Math.floor((y * height) / pixels.height)) * width;
    for (let x = 0; x < pixels.width; x += 1) {
      const at = (y * pixels.width + x) * 4;
      const cell = row + Math.min(width - 1, Math.floor((x * width) / pixels.width));
      sums[cell] += 0.299 * pixels.data[at] + 0.587 * pixels.data[at + 1] + 0.114 * pixels.data[at + 2];
      counts[cell] += 1;
    }
  }
  const gray = new Float32Array(width * height);
  for (let cell = 0; cell < gray.length; cell += 1) gray[cell] = counts[cell] ? sums[cell] / counts[cell] : 0;
  return { width, height, gray };
}

/**
 * The lines among `strengths` (how many pixels step at each boundary, out
 * of `length`): a boundary is a line when enough of it steps, and a run of
 * neighbouring lines keeps only its strongest. Returns boundary indices.
 */
function strongLines(strengths: Uint32Array, length: number): number[] {
  const needed = Math.max(1, Math.ceil(length * EDGE_SHARE));
  const lines: number[] = [];
  let best = -1;
  for (let at = 0; at <= strengths.length; at += 1) {
    const strong = at < strengths.length && strengths[at] >= needed;
    if (strong) {
      if (best < 0 || strengths[at] > strengths[best]) best = at;
    } else if (best >= 0) {
      // The run of neighbouring lines has ended.
      lines.push(best);
      best = -1;
    }
  }
  return lines;
}

/**
 * The strong horizontal and vertical lines in a capture, such as window
 * borders and panel edges, found on a downscaled grayscale copy. A column
 * (row) boundary is a line when at least `EDGE_SHARE` of its pixels step by
 * `EDGE_STEP` or more gray levels across it. `size` is the capture the
 * pixels show, when they are a smaller copy of it; lines are given in its
 * pixels, where the boundary falls.
 */
export function findEdges(pixels: Pixels, size: { width: number; height: number } = pixels): Edges {
  if (pixels.width < 2 && pixels.height < 2) return NO_EDGES;
  const { width, height, gray } = grayscale(pixels);
  // columns[c]: rows that step between column c and c + 1; rows[r] likewise.
  const columns = new Uint32Array(Math.max(0, width - 1));
  const rows = new Uint32Array(Math.max(0, height - 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const here = gray[y * width + x];
      if (x + 1 < width && Math.abs(gray[y * width + x + 1] - here) >= EDGE_STEP) columns[x] += 1;
      if (y + 1 < height && Math.abs(gray[(y + 1) * width + x] - here) >= EDGE_STEP) rows[y] += 1;
    }
  }
  const toCapture = (boundary: number, cells: number, span: number) => Math.round(((boundary + 1) * span) / cells);
  return {
    x: strongLines(columns, height).map((boundary) => toCapture(boundary, width, size.width)),
    y: strongLines(rows, width).map((boundary) => toCapture(boundary, height, size.height)),
  };
}

/**
 * The edges in a loaded capture, read from a copy drawn at most
 * `EDGE_SCAN_SIZE` on its long side. None where canvas pixels cannot be
 * read (jsdom, a lost context).
 */
export function imageEdges(image: CanvasImageSource & { width: number; height: number }): Edges {
  if (!(image.width > 0 && image.height > 0)) return NO_EDGES;
  const factor = Math.max(1, Math.max(image.width, image.height) / EDGE_SCAN_SIZE);
  const width = Math.max(1, Math.round(image.width / factor));
  const height = Math.max(1, Math.round(image.height / factor));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return NO_EDGES;
    context.drawImage(image, 0, 0, width, height);
    return findEdges(context.getImageData(0, 0, width, height), { width: image.width, height: image.height });
  } catch {
    return NO_EDGES;
  }
}

/**
 * Edges found in capture pixels (of a capture of `size`) as they show for
 * orientation `o`: a quarter turn swaps vertical and horizontal lines, and
 * a mirror puts a line at the far side (size minus the line).
 */
export function orientEdges(edges: Edges, size: { width: number; height: number }, o: Orientation): Edges {
  const x: number[] = [];
  const y: number[] = [];
  // A capture line is two points; on show it runs one way or the other.
  const place = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const a = toDisplay(from, size, o);
    const b = toDisplay(to, size, o);
    if (a.x === b.x) x.push(a.x);
    else y.push(a.y);
  };
  for (const line of edges.x) place({ x: line, y: 0 }, { x: line, y: size.height });
  for (const line of edges.y) place({ x: 0, y: line }, { x: size.width, y: line });
  const ascending = (a: number, b: number) => a - b;
  return { x: x.sort(ascending), y: y.sort(ascending) };
}
