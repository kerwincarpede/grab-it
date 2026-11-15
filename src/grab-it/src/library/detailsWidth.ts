/** How wide the Library's details pane may be, in pixels. */
export const DETAILS_WIDTH = { min: 360, max: 720, initial: 400 };
/** The grid keeps at least this much room beside the details. */
const GRID_MIN_WIDTH = 360;

export function clampDetailsWidth(width: number, room = Infinity): number {
  const max = Math.max(DETAILS_WIDTH.min, Math.min(DETAILS_WIDTH.max, room - GRID_MIN_WIDTH));
  return Math.round(Math.min(max, Math.max(DETAILS_WIDTH.min, width)));
}
