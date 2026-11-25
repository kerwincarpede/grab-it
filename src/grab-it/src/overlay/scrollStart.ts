/** A band of the overlay the start label must not sit under, in CSS px. */
export interface Blocker {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Half the start label's height, as it straddles the held area's top edge. */
export const START_LABEL_HALF = 12;
/** Room the start label is given across, wider than it draws. */
export const START_LABEL_WIDTH = 150;
/** Space kept between the label and something it moved below. */
const GAP = 4;

/**
 * Where the scrolling capture's Image starts here label is centred down the
 * overlay: on the held area's top edge (`edge`), or, when that would put it
 * under the toolbar or the guide panel (`blockers`), just below them and
 * so inside the area. `left` is the label's left edge. `inside` says it moved.
 */
export function startLabelY(
  edge: number,
  left: number,
  blockers: readonly Blocker[],
): { y: number; inside: boolean } {
  let y = Math.max(edge, START_LABEL_HALF);
  const right = left + START_LABEL_WIDTH;
  // Top to bottom, so moving below one band can still meet the next.
  for (const band of [...blockers].sort((a, b) => a.top - b.top)) {
    const across = band.left < right && band.right > left;
    const down = band.top < y + START_LABEL_HALF && band.bottom > y - START_LABEL_HALF;
    if (across && down) y = band.bottom + START_LABEL_HALF + GAP;
  }
  return { y, inside: y > edge };
}
