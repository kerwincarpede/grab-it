/**
 * The timeline's zoom: 1 fits the whole timeline in view, and each step
 * doubles it, up to 400 px a second. The helpers below work in the track's
 * pixels: `viewWidth` is how wide the visible track is, which is also the
 * whole track's width at 1x.
 */

/** The closest zoom: this many pixels for each second. */
export const MAX_PX_PER_SECOND = 400;
/** Each Zoom in doubles the zoom; each Zoom out halves it. */
export const ZOOM_STEP = 2;

/**
 * The multiple of fit that `pxPerSecond` shows at, at least 1. The zoom
 * limit and the shown zoom both come from here, so a scale at the limit
 * shows exactly at it.
 */
function multipleOfFit(pxPerSecond: number, durationMs: number, viewWidth: number): number {
  if (durationMs <= 0 || viewWidth <= 0) return 1;
  return Math.max(1, (pxPerSecond * durationMs) / 1000 / viewWidth);
}

/** How far in the timeline can zoom: at least 1, so a short timeline still fits. */
export function maxZoom(durationMs: number, viewWidth: number): number {
  return multipleOfFit(MAX_PX_PER_SECOND, durationMs, viewWidth);
}

/** `zoom` kept between 1 and the most the timeline allows. */
export function clampZoom(zoom: number, durationMs: number, viewWidth: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(maxZoom(durationMs, viewWidth), Math.max(1, zoom));
}

/** One step in (`1`) or out (`-1`) from `zoom`, within the limits. */
export function stepZoom(zoom: number, direction: 1 | -1, durationMs: number, viewWidth: number): number {
  return clampZoom(direction > 0 ? zoom * ZOOM_STEP : zoom / ZOOM_STEP, durationMs, viewWidth);
}

/**
 * The zoom chosen as pixels a second, or null to fit. It stays as chosen
 * while the timeline's length or width changes, so what is on screen keeps
 * its size; only what shows is clamped.
 */
export type TimelineScale = number | null;

/** The multiple of fit that `scale` shows at, clamped to 1x and 400 px a second. */
export function zoomFor(scale: TimelineScale, durationMs: number, viewWidth: number): number {
  if (scale === null || !Number.isFinite(scale)) return 1;
  return multipleOfFit(Math.min(MAX_PX_PER_SECOND, scale), durationMs, viewWidth);
}

/** The scale that shows at `zoom`: null at 1x, which fits, and never past 400 px a second. */
export function scaleFor(zoom: number, durationMs: number, viewWidth: number): TimelineScale {
  if (zoom <= 1 || durationMs <= 0 || viewWidth <= 0) return null;
  if (zoom >= maxZoom(durationMs, viewWidth)) return MAX_PX_PER_SECOND;
  return Math.min(MAX_PX_PER_SECOND, (zoom * viewWidth * 1000) / durationMs);
}

/** One step in (`1`) or out (`-1`) from the zoom `scale` shows at. */
export function stepScale(scale: TimelineScale, direction: 1 | -1, durationMs: number, viewWidth: number): TimelineScale {
  return scaleFor(stepZoom(zoomFor(scale, durationMs, viewWidth), direction, durationMs, viewWidth), durationMs, viewWidth);
}

/** The furthest the track scrolls at `zoom`. */
export function maxScroll(zoom: number, viewWidth: number): number {
  return Math.max(0, viewWidth * zoom - viewWidth);
}

/**
 * The scroll offset that puts time `ms` `offset` pixels from the visible
 * track's left edge at `zoom`, such as the time under the pointer after a
 * zoom. Kept within the track.
 */
export function scrollToKeep(ms: number, offset: number, zoom: number, durationMs: number, viewWidth: number): number {
  if (durationMs <= 0 || viewWidth <= 0) return 0;
  const x = (ms / durationMs) * viewWidth * zoom;
  // Whole pixels, as the browser keeps them.
  return Math.round(Math.min(maxScroll(zoom, viewWidth), Math.max(0, x - offset)));
}

/** The time at `offset` pixels into the visible track, scrolled by `scrollLeft` at `zoom`. */
export function msAtOffset(offset: number, scrollLeft: number, zoom: number, durationMs: number, viewWidth: number): number {
  if (durationMs <= 0 || viewWidth <= 0) return 0;
  return Math.min(durationMs, Math.max(0, ((scrollLeft + offset) / (viewWidth * zoom)) * durationMs));
}

/** The stretch of the timeline in view, in ms. */
export function visibleRange(scrollLeft: number, zoom: number, durationMs: number, viewWidth: number): { startMs: number; endMs: number } {
  return { startMs: msAtOffset(0, scrollLeft, zoom, durationMs, viewWidth), endMs: msAtOffset(viewWidth, scrollLeft, zoom, durationMs, viewWidth) };
}

/** Where the playhead lands when following it pages the view on: this share in from the left. */
const FOLLOW_LEAD = 0.1;
/** How near the right edge the playhead may come before the view moves on. */
const FOLLOW_EDGE = 0.9;

/**
 * The scroll offset that keeps a playing playhead at `ms` in view: the
 * same offset while it is well inside, or one that pages it back near the
 * left edge once it nears the right edge or falls outside.
 */
export function followScroll(ms: number, scrollLeft: number, zoom: number, durationMs: number, viewWidth: number): number {
  if (zoom <= 1 || durationMs <= 0 || viewWidth <= 0) return scrollLeft;
  const x = (ms / durationMs) * viewWidth * zoom;
  if (x >= scrollLeft && x <= scrollLeft + viewWidth * FOLLOW_EDGE) return scrollLeft;
  return scrollToKeep(ms, viewWidth * FOLLOW_LEAD, zoom, durationMs, viewWidth);
}
