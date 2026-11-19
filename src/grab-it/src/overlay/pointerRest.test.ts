import { describe, expect, it } from "vitest";
import { EMPTY_TRAIL, REST_MS, movedTo, pointedAt, reachedToolbar } from "./pointerRest";

describe("pointer rest", () => {
  it("points at where the pointer rested, not what it crossed on its way to the toolbar", () => {
    let trail = movedTo(EMPTY_TRAIL, { x: 700, y: 600 }, 0);
    trail = movedTo(trail, { x: 720, y: 500 }, REST_MS + 10);
    trail = movedTo(trail, { x: 740, y: 300 }, REST_MS + 20);
    trail = movedTo(trail, { x: 760, y: 100 }, REST_MS + 30);
    trail = reachedToolbar(trail, REST_MS + 40);
    expect(pointedAt(trail)).toEqual({ x: 700, y: 600 });
  });

  it("counts a rest just before the toolbar", () => {
    let trail = movedTo(EMPTY_TRAIL, { x: 700, y: 600 }, 0);
    trail = movedTo(trail, { x: 760, y: 100 }, REST_MS + 10);
    trail = reachedToolbar(trail, 2 * REST_MS + 20);
    expect(pointedAt(trail)).toEqual({ x: 760, y: 100 });
  });

  it("falls back to the last position when the pointer never rested", () => {
    let trail = movedTo(EMPTY_TRAIL, { x: 10, y: 10 }, 0);
    trail = movedTo(trail, { x: 20, y: 20 }, 5);
    trail = reachedToolbar(trail, 10);
    expect(pointedAt(trail)).toEqual({ x: 20, y: 20 });
    expect(pointedAt(EMPTY_TRAIL)).toBeNull();
  });

  it("does not count time over the toolbar as a rest outside it", () => {
    let trail = movedTo(EMPTY_TRAIL, { x: 700, y: 600 }, 0);
    trail = movedTo(trail, { x: 760, y: 100 }, REST_MS + 10);
    trail = reachedToolbar(trail, REST_MS + 20);
    // Lingering over the toolbar, then leaving and coming straight back.
    trail = reachedToolbar(trail, 5 * REST_MS);
    trail = movedTo(trail, { x: 760, y: 120 }, 6 * REST_MS);
    trail = reachedToolbar(trail, 6 * REST_MS + 10);
    expect(pointedAt(trail)).toEqual({ x: 700, y: 600 });
  });
});
