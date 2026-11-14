import { describe, expect, it } from "vitest";
import {
  advanceDrag,
  cutoutPath,
  hintTop,
  boxFromPoints,
  clampedDelta,
  contains,
  dragBox,
  floatingPosition,
  imagePixelAt,
  imageSize,
  isDrag,
  labelPlacement,
  monitorToCss,
  squareHead,
  toHex,
  topmostAt,
} from "./geometry";

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

describe("squareHead", () => {
  it("takes the longer side, in the direction of the drag", () => {
    expect(squareHead({ x: 100, y: 100 }, { x: 160, y: 120 })).toEqual({ x: 160, y: 160 });
    expect(squareHead({ x: 100, y: 100 }, { x: 80, y: 40 })).toEqual({ x: 40, y: 40 });
    expect(squareHead({ x: 100, y: 100 }, { x: 130, y: 50 })).toEqual({ x: 150, y: 50 });
  });

  it("grows down-right from a straight drag", () => {
    expect(squareHead({ x: 10, y: 10 }, { x: 40, y: 10 })).toEqual({ x: 40, y: 40 });
  });

  it("stops growing at the edge of the bounds", () => {
    const bounds = { width: 200, height: 150 };
    expect(squareHead({ x: 100, y: 100 }, { x: 190, y: 110 }, bounds)).toEqual({ x: 150, y: 150 });
    expect(squareHead({ x: 30, y: 100 }, { x: 0, y: 20 }, bounds)).toEqual({ x: 0, y: 70 });
  });
});

describe("dragBox", () => {
  const drag = { anchor: { x: 50, y: 50 }, head: { x: 10, y: 30 } };

  it("is the plain rectangle by default", () => {
    expect(dragBox(drag)).toEqual({ x: 10, y: 30, width: 40, height: 20 });
  });

  it("is a square when constrained", () => {
    expect(dragBox(drag, true)).toEqual({ x: 10, y: 10, width: 40, height: 40 });
  });
});

describe("clampedDelta", () => {
  const bounds = { width: 100, height: 100 };
  const box = { x: 10, y: 20, width: 30, height: 30 };

  it("passes a move that stays on screen", () => {
    expect(clampedDelta(box, { x: 5, y: -5 }, bounds)).toEqual({ x: 5, y: -5 });
  });

  it("stops at the edges", () => {
    expect(clampedDelta(box, { x: -50, y: 80 }, bounds)).toEqual({ x: -10, y: 50 });
  });

  it("holds a box larger than the bounds still", () => {
    expect(clampedDelta({ x: -5, y: 0, width: 200, height: 10 }, { x: 9, y: 0 }, bounds).x).toBe(0);
  });
});

describe("advanceDrag", () => {
  const bounds = { width: 1000, height: 800 };
  const drag = { anchor: { x: 100, y: 100 }, head: { x: 200, y: 150 } };

  it("resizes by following the cursor", () => {
    const resized = advanceDrag(
      drag,
      { x: 200, y: 150 },
      { x: 260, y: 90 },
      { move: false, square: false, bounds },
    );
    expect(resized).toEqual({ anchor: { x: 100, y: 100 }, head: { x: 260, y: 90 } });
  });

  it("moves the whole selection while Space is held", () => {
    const moved = advanceDrag(
      drag,
      { x: 200, y: 150 },
      { x: 230, y: 140 },
      { move: true, square: false, bounds },
    );
    expect(moved).toEqual({ anchor: { x: 130, y: 90 }, head: { x: 230, y: 140 } });
    expect(dragBox(moved)).toMatchObject({ width: 100, height: 50 });
  });

  it("keeps a moved selection on screen", () => {
    const moved = advanceDrag(
      drag,
      { x: 200, y: 150 },
      { x: 0, y: 0 },
      { move: true, square: false, bounds },
    );
    expect(dragBox(moved)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("moves the square, not the raw drag, when both keys are held", () => {
    // The square is 100 tall, so it can only rise 100 before hitting the top.
    const moved = advanceDrag(
      drag,
      { x: 200, y: 150 },
      { x: 200, y: 0 },
      { move: true, square: true, bounds },
    );
    expect(dragBox(moved, true)).toEqual({ x: 100, y: 0, width: 100, height: 100 });
  });
});

describe("image pixels", () => {
  it("sizes a selection in image pixels", () => {
    expect(imageSize({ x: 0, y: 0, width: 200, height: 100.4 }, 2)).toEqual({
      width: 400,
      height: 201,
    });
  });

  it("finds the image pixel under a point", () => {
    const image = { width: 2000, height: 1600 };
    expect(imagePixelAt({ x: 10.6, y: 20 }, 2, image)).toEqual({ x: 21, y: 40 });
  });

  it("stays inside the image", () => {
    const image = { width: 2000, height: 1600 };
    expect(imagePixelAt({ x: 1000, y: -3 }, 2, image)).toEqual({ x: 1999, y: 0 });
  });
});

describe("labelPlacement", () => {
  const viewport = { width: 1000, height: 800 };
  const label = { width: 120, height: 30 };

  it("prefers above the selection, lined up with its left edge", () => {
    expect(labelPlacement({ x: 100, y: 100, width: 50, height: 50 }, label, viewport)).toEqual({
      side: "above",
      align: "start",
    });
  });

  it("drops below when there is no room above", () => {
    expect(labelPlacement({ x: 100, y: 10, width: 50, height: 50 }, label, viewport).side).toBe(
      "below",
    );
  });

  it("goes inside a selection that spans the full height", () => {
    expect(labelPlacement({ x: 100, y: 0, width: 50, height: 800 }, label, viewport).side).toBe(
      "inside",
    );
  });

  it("lines up with the right edge near the right of the screen", () => {
    expect(labelPlacement({ x: 950, y: 100, width: 40, height: 40 }, label, viewport).align).toBe(
      "end",
    );
  });
});

describe("floatingPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const panel = { width: 120, height: 166 };

  it("trails the cursor down-right", () => {
    expect(floatingPosition({ x: 100, y: 100 }, panel, viewport, 20)).toEqual({ x: 120, y: 120 });
  });

  it("flips near the right and bottom edges", () => {
    expect(floatingPosition({ x: 950, y: 100 }, panel, viewport, 20)).toEqual({ x: 810, y: 120 });
    expect(floatingPosition({ x: 100, y: 700 }, panel, viewport, 20)).toEqual({ x: 120, y: 514 });
  });

  it("never leaves the screen in a viewport smaller than the panel", () => {
    expect(floatingPosition({ x: 50, y: 50 }, panel, { width: 100, height: 100 }, 20)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe("toHex", () => {
  it("writes upper-case, zero-padded hex", () => {
    expect(toHex(26, 43, 60)).toBe("#1A2B3C");
    expect(toHex(0, 0, 255)).toBe("#0000FF");
  });
});

describe("cutoutPath", () => {
  it("covers the screen except a rounded hole for the window", () => {
    const path = cutoutPath({ x: 100, y: 50, width: 300, height: 200 }, { width: 1440, height: 900 }, 10);
    expect(path).toBe(
      'path(evenodd, "M0 0H1440V900H0Z ' +
        "M110 50H390A10 10 0 0 1 400 60V240A10 10 0 0 1 390 250H110A10 10 0 0 1 100 240V60A10 10 0 0 1 110 50Z\")",
    );
  });

  it("keeps the corners no rounder than a small window allows", () => {
    expect(cutoutPath({ x: 0, y: 0, width: 8, height: 30 }, { width: 100, height: 100 }, 10)).toContain("A4 4");
  });
});

describe("hintTop", () => {
  it("sits just below the menu bar or notch", () => {
    // A 37-point notch on a 982-point-tall screen.
    expect(hintTop(37 / 982, 982)).toBe(49);
    expect(hintTop(0, 900)).toBe(12);
    // Older backends say nothing; nonsense is ignored.
    expect(hintTop(undefined, 900)).toBe(12);
    expect(hintTop(Number.NaN, 900)).toBe(12);
    expect(hintTop(0.9, 1000)).toBe(212);
  });
});
