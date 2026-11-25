import type { Box } from "./geometry";
import type { Blocker } from "./scrollStart";

/** The edge of the display Scroll's guide sits against. */
export type GuideEdge = "top" | "bottom";

/** How much of `area` lies under `band`, in CSS px². */
function covered(area: Box, band: Blocker): number {
  const across = Math.min(area.x + area.width, band.right) - Math.max(area.x, band.left);
  const down = Math.min(area.y + area.height, band.bottom) - Math.max(area.y, band.top);
  return across > 0 && down > 0 ? across * down : 0;
}

/**
 * Where Scroll's guide goes for the held `area`, given where it would sit
 * against each edge (`bands`). It stays on `current` while nothing is held
 * or the area is clear of it, and moves only when the area lies under it
 * and less of the area would lie under it on the other edge. So it never
 * moves while the user is just choosing, and moves at most once per area.
 */
export function nextGuideEdge(
  current: GuideEdge,
  area: Box | null,
  bands: Record<GuideEdge, Blocker>,
): GuideEdge {
  if (!area) return current;
  const here = covered(area, bands[current]);
  if (here === 0) return current;
  const other: GuideEdge = current === "top" ? "bottom" : "top";
  return covered(area, bands[other]) < here ? other : current;
}

/**
 * Whether this display shows Scroll's guide: the one holding the area held
 * last, or with nothing held anywhere, the one the pointer is on. So there
 * is only ever one guide across the displays.
 */
export function showsGuide(held: boolean, heldElsewhere: boolean, pointerHere: boolean): boolean {
  if (heldElsewhere) return false;
  return held || pointerHere;
}
