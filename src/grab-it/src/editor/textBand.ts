import type { Pixels } from "./edges";
import type { PathShape, Rect } from "./model";

/** The rows a line of text covers, in capture pixels: `top` is its first row, `bottom` the row after its last. */
export interface Band {
  top: number;
  bottom: number;
}

/** A highlighter drag fits the text under it only when it runs within this angle of horizontal. */
export const BAND_MAX_ANGLE = (15 * Math.PI) / 180;
/** A drag shorter than this, in capture pixels, is not fitted. */
export const BAND_MIN_LENGTH = 8;
/** How far a pixel's channels (summed) must be from the background colour to count as text. */
export const INK_DIFFERENCE = 96;
/** The least a fitted highlighter looks above and below its drag, in capture pixels; see `bandReach`. */
export const BAND_REACH = 48;
/** The thinnest band that counts as text, in capture pixels: anything thinner is a rule, border or underline. */
export const BAND_MIN_HEIGHT = 5;
/** Blank rows a line of text may have inside it (between an `i` and its dot) and still be one line. */
export const BAND_GAP = 1;

/** How far above and below its drag a highlighter of `strokeWidth` looks for text: twice its width, and at least `BAND_REACH`. */
export function bandReach(strokeWidth: number): number {
  return Math.max(BAND_REACH, strokeWidth * 2);
}

/** The `x, y` pairs of a path as points. */
function pathPoints(points: number[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) out.push({ x: points[i], y: points[i + 1] });
  return out;
}

/**
 * The part of a capture of `size` to look for text in under a highlighter
 * drag along `points`: the columns the drag spans and `reach` rows above
 * and below the drag's middle, clipped to the capture. Null when the drag
 * is too short, more than `BAND_MAX_ANGLE` from horizontal, or wanders up
 * or down by more than `reach`.
 */
export function bandWindow(points: number[], reach: number, size: { width: number; height: number }): Rect | null {
  const path = pathPoints(points);
  if (path.length < 2) return null;
  const start = path[0];
  const end = path[path.length - 1];
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (Math.hypot(dx, dy) < BAND_MIN_LENGTH || Math.atan2(dy, dx) > BAND_MAX_ANGLE) return null;
  const ys = path.map((point) => point.y);
  const middle = (Math.min(...ys) + Math.max(...ys)) / 2;
  if (Math.max(...ys) - Math.min(...ys) > reach) return null;
  const xs = path.map((point) => point.x);
  const left = Math.max(0, Math.floor(Math.min(...xs)));
  const right = Math.min(size.width, Math.ceil(Math.max(...xs)));
  const top = Math.max(0, Math.floor(middle - reach));
  const bottom = Math.min(size.height, Math.ceil(middle + reach));
  if (right - left < 1 || bottom - top < 1) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The line of text in `area` of `pixels` nearest row `middle`: the run of
 * rows whose pixels differ from the background (the area's most common
 * colour), allowing `BAND_GAP` blank rows inside it. Null when no row
 * within `near` rows of `middle` has text (by default an eighth of the
 * area's height, a quarter of its reach), when the run is thinner than
 * `BAND_MIN_HEIGHT`, or when it reaches the top or bottom of the area,
 * which is a picture or a block of text rather than one line.
 */
export function findTextBand(pixels: Pixels, area: Rect, middle: number, near = area.height / 8): Band | null {
  const { data, width } = pixels;
  const at = (x: number, y: number) => (y * width + x) * 4;
  // The background is the most common colour, read 4 bits a channel so slight shading counts as one colour.
  const counts = new Map<number, number>();
  let background = 0;
  let most = 0;
  for (let y = area.y; y < area.y + area.height; y += 1) {
    for (let x = area.x; x < area.x + area.width; x += 1) {
      const i = at(x, y);
      const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count > most) {
        most = count;
        background = i;
      }
    }
  }
  const [br, bg, bb] = [data[background], data[background + 1], data[background + 2]];
  const ink: boolean[] = [];
  for (let y = area.y; y < area.y + area.height; y += 1) {
    let found = false;
    for (let x = area.x; x < area.x + area.width && !found; x += 1) {
      const i = at(x, y);
      found = Math.abs(data[i] - br) + Math.abs(data[i + 1] - bg) + Math.abs(data[i + 2] - bb) >= INK_DIFFERENCE;
    }
    ink.push(found);
  }
  // The inked row nearest the drag's middle.
  const centre = Math.min(ink.length - 1, Math.max(0, Math.round(middle) - area.y));
  let seed = -1;
  for (let offset = 0; offset <= near && seed < 0; offset += 1) {
    if (ink[centre - offset]) seed = centre - offset;
    else if (ink[centre + offset]) seed = centre + offset;
  }
  if (seed < 0) return null;
  // Grow the run both ways, across gaps of up to BAND_GAP blank rows.
  const grow = (from: number, step: 1 | -1) => {
    let edge = from;
    for (let row = from + step; row >= 0 && row < ink.length; row += step) {
      if (ink[row]) edge = row;
      else if (Math.abs(row - edge) > BAND_GAP) break;
    }
    return edge;
  };
  const first = grow(seed, -1);
  const last = grow(seed, 1);
  if (first === 0 || last === ink.length - 1 || last + 1 - first < BAND_MIN_HEIGHT) return null;
  return { top: area.y + first, bottom: area.y + last + 1 };
}

/**
 * The line of text a highlighter drag along `points` lies over, read from
 * `pixels` (the whole capture): see `bandWindow` and `findTextBand`.
 */
export function textBand(pixels: Pixels, points: number[], reach: number): Band | null {
  const area = bandWindow(points, reach, pixels);
  return area ? findTextBand(pixels, area, area.y + area.height / 2) : null;
}

/**
 * Like `textBand`, reading only the part of a loaded capture under the
 * drag. Null where canvas pixels cannot be read (jsdom, a lost context).
 */
export function imageTextBand(image: CanvasImageSource & { width: number; height: number }, points: number[], reach: number): Band | null {
  const area = bandWindow(points, reach, image);
  if (!area) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = area.width;
    canvas.height = area.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
    const band = findTextBand(context.getImageData(0, 0, area.width, area.height), { x: 0, y: 0, width: area.width, height: area.height }, area.height / 2);
    return band && { top: band.top + area.y, bottom: band.bottom + area.y };
  } catch {
    return null;
  }
}

/**
 * A highlighter stroke swapped for a straight bar over `band`: from the
 * drag's leftmost to its rightmost point, centred on the band and as tall
 * as it.
 */
export function fitToBand(shape: PathShape, band: Band): PathShape {
  const xs = pathPoints(shape.points).map((point) => point.x);
  const y = (band.top + band.bottom) / 2;
  return { ...shape, points: [Math.min(...xs), y, Math.max(...xs), y], strokeWidth: band.bottom - band.top };
}
