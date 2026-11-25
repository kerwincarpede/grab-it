import { describe, expect, it } from "vitest";
import { START_LABEL_HALF, startLabelY } from "./scrollStart";

const TOOLBAR = { top: 36, bottom: 86, left: 0, right: 1000 };

describe("startLabelY", () => {
  it("sits on the held area's top edge when nothing covers it", () => {
    expect(startLabelY(300, 116, [TOOLBAR])).toEqual({ y: 300, inside: false });
  });

  it("stays on screen for an area at the very top", () => {
    expect(startLabelY(0, 16, [])).toEqual({ y: START_LABEL_HALF, inside: true });
  });

  it("moves below the toolbar, inside the area, when the edge is under it", () => {
    const { y, inside } = startLabelY(40, 16, [TOOLBAR]);
    expect(inside).toBe(true);
    expect(y - START_LABEL_HALF).toBeGreaterThanOrEqual(TOOLBAR.bottom);
  });

  it("moves below the guide panel too when it lies under the toolbar", () => {
    const guide = { top: 94, bottom: 450, left: 280, right: 720 };
    const { y } = startLabelY(40, 300, [guide, TOOLBAR]);
    expect(y - START_LABEL_HALF).toBeGreaterThanOrEqual(guide.bottom);
  });

  it("ignores a panel off to the side", () => {
    const guide = { top: 94, bottom: 450, left: 280, right: 720 };
    const { y } = startLabelY(40, 16, [guide, TOOLBAR]);
    expect(y).toBeLessThan(guide.bottom);
    expect(y - START_LABEL_HALF).toBeGreaterThanOrEqual(TOOLBAR.bottom);
  });
});
