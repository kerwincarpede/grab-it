import type { Point } from "./geometry";

/** How long the pointer stays still, in ms, for where it stopped to count as pointed at. */
export const REST_MS = 150;

/**
 * Where the pointer has been, so the main button acts on the window or
 * pixel the user pointed at and not on whatever the pointer crossed on its
 * way to the toolbar.
 */
export interface PointerTrail {
  /** The last position outside the toolbar, and when the pointer got there. */
  last: { point: Point; at: number } | null;
  /** The last position the pointer rested on before it reached the toolbar. */
  rested: Point | null;
  /** The pointer is over the toolbar now. */
  onToolbar: boolean;
}

export const EMPTY_TRAIL: PointerTrail = { last: null, rested: null, onToolbar: false };

/** The rested position once the pointer leaves `trail.last` at `at`. */
function settle(trail: PointerTrail, at: number): Point | null {
  return trail.last && at - trail.last.at >= REST_MS ? trail.last.point : trail.rested;
}

/** The pointer moved to `point` at `at`, outside the toolbar. */
export function movedTo(trail: PointerTrail, point: Point, at: number): PointerTrail {
  // Time spent over the toolbar is not a rest where the pointer was before it.
  const rested = trail.onToolbar ? trail.rested : settle(trail, at);
  return { last: { point, at }, rested, onToolbar: false };
}

/** The pointer moved over the toolbar at `at`. */
export function reachedToolbar(trail: PointerTrail, at: number): PointerTrail {
  if (trail.onToolbar) return trail;
  return { ...trail, rested: settle(trail, at), onToolbar: true };
}

/**
 * What the pointer stands for over the toolbar: where it last rested, or
 * where it last was when it never rested.
 */
export function pointedAt(trail: PointerTrail): Point | null {
  return trail.rested ?? trail.last?.point ?? null;
}
