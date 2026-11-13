import { describe, expect, it } from "vitest";
import { boxFromPoints, contains, isDrag, monitorToCss, topmostAt } from "./geometry";

describe("boxFromPoints", () => {
  it("normalises drags in any direction", () => {
    expect(boxFromPoints({ x: 50, y: 40 }, { x: 10, y: 100 })).toEqual({
      x: 10,
      y: 40,
      width: 40,
      height: 60,
    });
  });

  it("treats tiny drags as clicks", () => {
    expect(isDrag(boxFromPoints({ x: 5, y: 5 }, { x: 7, y: 6 }))).toBe(false);
    expect(isDrag(boxFromPoints({ x: 5, y: 5 }, { x: 5, y: 15 }))).toBe(true);
  });
});

describe("monitorToCss", () => {
  it("scales monitor units into the overlay's CSS pixels", () => {
    // A 2560 px wide monitor at 2x shows a 1280 CSS px wide overlay.
    expect(
      monitorToCss(
        { x: 200, y: 100, width: 800, height: 600 },
        { width: 2560, height: 1440 },
        { width: 1280, height: 720 },
      ),
    ).toEqual({ x: 100, y: 50, width: 400, height: 300 });
  });

  it("keeps units when the monitor is unknown", () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };
    expect(monitorToCss(box, { width: 0, height: 0 }, { width: 10, height: 10 })).toEqual(box);
  });
});

describe("topmostAt", () => {
  const items = [
    { id: "front", box: { x: 0, y: 0, width: 10, height: 10 } },
    { id: "back", box: { x: 0, y: 0, width: 100, height: 100 } },
  ];

  it("picks the frontmost window under the point", () => {
    expect(topmostAt(items, { x: 5, y: 5 })?.id).toBe("front");
    expect(topmostAt(items, { x: 50, y: 50 })?.id).toBe("back");
    expect(topmostAt(items, { x: 150, y: 50 })).toBeUndefined();
  });

  it("excludes the right and bottom edges", () => {
    expect(contains({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 5 })).toBe(false);
  });
});
