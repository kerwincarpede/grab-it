/**
 * Zoom segments: a stretch of the recording shown larger, centred on a
 * chosen point of the frame or on the pointer. Each eases in and out over
 * `ZOOM_EASE_MS`, and the zoomed view never leaves the frame.
 *
 * `viewAt` is what the preview shows; src-tauri/src/zoom.rs computes the
 * same view for each exported frame, from the same smoothed pointer path
 * (`RecordingInfo.cursor`). Keep the two in step.
 */

/** What a zoom centres on: a point (fractions of the frame), or the pointer. */
export type ZoomFocus = { kind: "area"; x: number; y: number } | { kind: "cursor" };

export interface Zoom {
  id: string;
  /**
   * The recordings-folder reference of the recording the zoom is on;
   * absent for the sidecar's own recording. Zooms keep their source's
   * time, so they move with its clip.
   */
  source?: string;
  /** In the source recording's time, not the joined sequence's. */
  startMs: number;
  endMs: number;
  /** How many times larger the zoomed area shows. */
  scale: number;
  focus: ZoomFocus;
}

/**
 * The pointer's path, smoothed by Grab-it from `<recording>.cursor.json`:
 * a point a frame, as fractions of the frame. Mirrors `CursorPath` in
 * src-tauri/src/zoom.rs.
 */
export interface CursorPath {
  fps: number;
  points: [number, number][];
}

/** The part of the frame showing: `scale` times as large, centred on `x`, `y` (fractions). */
export interface ZoomView {
  scale: number;
  x: number;
  y: number;
}

/** Mirrors `EASE_MS` in src-tauri/src/zoom.rs. */
export const ZOOM_EASE_MS = 300;
export const MIN_ZOOM_MS = 500;
export const DEFAULT_ZOOM_MS = 2000;
export const MIN_ZOOM_SCALE = 1.25;
export const MAX_ZOOM_SCALE = 4;
export const DEFAULT_ZOOM_SCALE = 2;
export const ZOOM_SCALE_STEP = 0.25;

export const FULL_VIEW: ZoomView = { scale: 1, x: 0.5, y: 0.5 };

const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

let nextZoomId = 0;
export function newZoomId(): string {
  nextZoomId += 1;
  return `z${Date.now().toString(36)}${nextZoomId.toString(36)}`;
}

export const clampScale = (scale: number) => clamp(Math.round(scale / ZOOM_SCALE_STEP) * ZOOM_SCALE_STEP, MIN_ZOOM_SCALE, MAX_ZOOM_SCALE);

function parseFocus(value: unknown): ZoomFocus | null {
  if (!value || typeof value !== "object") return null;
  const focus = value as Record<string, unknown>;
  if (focus.kind === "cursor") return { kind: "cursor" };
  if (focus.kind === "area" && isNum(focus.x) && isNum(focus.y)) return { kind: "area", x: clamp(focus.x, 0, 1), y: clamp(focus.y, 0, 1) };
  return null;
}

/**
 * Reads the sidecar's `zooms`: entries that are not understood are
 * dropped, the rest sorted by start, and any that overlap an earlier one
 * dropped too, so zooms never overlap.
 */
export function parseZooms(value: unknown): Zoom[] {
  if (!Array.isArray(value)) return [];
  const zooms: Zoom[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const zoom = entry as Record<string, unknown>;
    const focus = parseFocus(zoom.focus);
    if (!focus || !isNum(zoom.startMs) || !isNum(zoom.endMs) || !isNum(zoom.scale) || zoom.startMs < 0 || zoom.endMs <= zoom.startMs) continue;
    zooms.push({
      id: typeof zoom.id === "string" && zoom.id ? zoom.id : newZoomId(),
      ...(typeof zoom.source === "string" && zoom.source ? { source: zoom.source } : {}),
      startMs: Math.round(zoom.startMs),
      endMs: Math.round(zoom.endMs),
      scale: clampScale(zoom.scale),
      focus,
    });
  }
  zooms.sort((a, b) => a.startMs - b.startMs);
  // Zooms on different recordings never meet, so overlaps count per source.
  const kept: Zoom[] = [];
  const lastEnd = new Map<string, number>();
  for (const zoom of zooms) {
    const key = zoom.source ?? "";
    if (zoom.startMs >= (lastEnd.get(key) ?? 0)) {
      kept.push(zoom);
      lastEnd.set(key, zoom.endMs);
    }
  }
  return kept;
}

// --- Editing ---------------------------------------------------------------

/** Where the zoom at `index` of the sorted `zooms` may reach: the ends of its neighbours, or of the recording. */
function room(zooms: Zoom[], index: number, durationMs: number): { low: number; high: number } {
  return { low: zooms[index - 1]?.endMs ?? 0, high: zooms[index + 1]?.startMs ?? Math.max(0, Math.round(durationMs)) };
}

const replace = (zooms: Zoom[], index: number, zoom: Zoom) => zooms.map((each, at) => (at === index ? zoom : each));

/**
 * Adds a `DEFAULT_ZOOM_MS` zoom at `atMs`, shorter when the next zoom or
 * the end is closer, and moved back to keep `MIN_ZOOM_MS` when it must.
 * Null when `atMs` is inside a zoom or the gap there is too short.
 */
export function addZoom(zooms: Zoom[], atMs: number, durationMs: number, focus: ZoomFocus = { kind: "area", x: 0.5, y: 0.5 }, id = newZoomId()): { zooms: Zoom[]; zoom: Zoom } | null {
  const duration = Math.max(0, Math.round(durationMs));
  const at = clamp(Math.round(atMs), 0, duration);
  if (zooms.some((zoom) => at >= zoom.startMs && at < zoom.endMs)) return null;
  const low = Math.max(0, ...zooms.filter((zoom) => zoom.endMs <= at).map((zoom) => zoom.endMs));
  const high = Math.min(duration, ...zooms.filter((zoom) => zoom.startMs > at).map((zoom) => zoom.startMs));
  if (high - low < MIN_ZOOM_MS) return null;
  const startMs = Math.max(low, Math.min(at, high - MIN_ZOOM_MS));
  const zoom: Zoom = { id, startMs, endMs: Math.min(startMs + DEFAULT_ZOOM_MS, high), scale: DEFAULT_ZOOM_SCALE, focus };
  return { zooms: [...zooms, zoom].sort((a, b) => a.startMs - b.startMs), zoom };
}

/** Moves zoom `id` to start at `startMs`, keeping its length, between its neighbours. */
export function moveZoom(zooms: Zoom[], id: string, startMs: number, durationMs: number): Zoom[] {
  const index = zooms.findIndex((zoom) => zoom.id === id);
  if (index < 0) return zooms;
  const zoom = zooms[index];
  const length = zoom.endMs - zoom.startMs;
  const { low, high } = room(zooms, index, durationMs);
  const start = Math.round(clamp(startMs, low, Math.max(low, high - length)));
  return replace(zooms, index, { ...zoom, startMs: start, endMs: start + length });
}

/** Moves one edge of zoom `id` to `ms`, keeping it `MIN_ZOOM_MS` long and clear of its neighbours. */
export function resizeZoom(zooms: Zoom[], id: string, edge: "start" | "end", ms: number, durationMs: number): Zoom[] {
  const index = zooms.findIndex((zoom) => zoom.id === id);
  if (index < 0) return zooms;
  const zoom = zooms[index];
  const { low, high } = room(zooms, index, durationMs);
  const next =
    edge === "start"
      ? { ...zoom, startMs: Math.round(clamp(ms, low, zoom.endMs - MIN_ZOOM_MS)) }
      : { ...zoom, endMs: Math.round(clamp(ms, zoom.startMs + MIN_ZOOM_MS, high)) };
  return replace(zooms, index, next);
}

/** Changes zoom `id`'s scale or focus. */
export function updateZoom(zooms: Zoom[], id: string, change: Partial<Pick<Zoom, "scale" | "focus">>): Zoom[] {
  return zooms.map((zoom) => (zoom.id === id ? { ...zoom, ...change, ...(change.scale !== undefined ? { scale: clampScale(change.scale) } : {}) } : zoom));
}

export function removeZoom(zooms: Zoom[], id: string): Zoom[] {
  return zooms.filter((zoom) => zoom.id !== id);
}

// --- The view at a time ------------------------------------------------------

/**
 * How far `zoom` is in at `ms`: 0 outside it, rising to 1 over its first
 * `ZOOM_EASE_MS` and falling back over its last (half the zoom each when
 * it is shorter), along a smoothstep. Mirrors `Zoom::strength`.
 */
export function zoomStrength(zoom: Pick<Zoom, "startMs" | "endMs">, ms: number): number {
  if (ms <= zoom.startMs || ms >= zoom.endMs) return 0;
  const ramp = Math.min(ZOOM_EASE_MS, (zoom.endMs - zoom.startMs) / 2);
  const p = Math.min(1, Math.min(ms - zoom.startMs, zoom.endMs - ms) / ramp);
  return p * p * (3 - 2 * p);
}

/** `target` moved just far enough that a view `scale` times as large stays inside the frame. Mirrors `clamp_centre`. */
export function clampCentre(target: [number, number], scale: number): [number, number] {
  const half = 0.5 / Math.max(1, scale);
  return [clamp(target[0], half, 1 - half), clamp(target[1], half, 1 - half)];
}

/** Where the pointer is at `ms`, between the frames either side. Mirrors `CursorPath::at`. */
export function cursorAt(path: CursorPath | null | undefined, ms: number): [number, number] | null {
  if (!path || path.points.length === 0) return null;
  const last = path.points.length - 1;
  const frame = clamp((ms * path.fps) / 1000, 0, last);
  const index = Math.floor(frame);
  const share = frame - index;
  const a = path.points[index];
  const b = path.points[Math.min(index + 1, last)];
  return [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share];
}

/** The view at `ms`: the zoom holding it, eased, centred on its focus and kept inside the frame. Mirrors `view_at`. */
export function viewAt(zooms: Zoom[], ms: number, cursor: CursorPath | null | undefined): ZoomView {
  const zoom = zooms.find((each) => ms > each.startMs && ms < each.endMs);
  if (!zoom) return FULL_VIEW;
  const scale = Math.pow(zoom.scale, zoomStrength(zoom, ms));
  const target: [number, number] = zoom.focus.kind === "area" ? [zoom.focus.x, zoom.focus.y] : (cursorAt(cursor, ms) ?? [0.5, 0.5]);
  const [x, y] = clampCentre(target, scale);
  return { scale, x, y };
}

/** A view's rectangle, as fractions of the frame. */
export function viewRect(view: ZoomView): { x: number; y: number; width: number; height: number } {
  const size = 1 / view.scale;
  return { x: view.x - size / 2, y: view.y - size / 2, width: size, height: size };
}

/** The CSS transform that shows `view` of a video filling its box. */
export function viewTransform(view: ZoomView): string {
  if (view.scale === 1) return "none";
  const rect = viewRect(view);
  const pct = (share: number) => `${-share * view.scale * 100}%`;
  return `translate(${pct(rect.x)}, ${pct(rect.y)}) scale(${view.scale})`;
}

/** How a zoom is named on the timeline and its controls. */
export const zoomLabel = (zoom: Zoom) => `${zoom.focus.kind === "cursor" ? "Follow-cursor" : "Area"} zoom ${zoom.scale}×`;
