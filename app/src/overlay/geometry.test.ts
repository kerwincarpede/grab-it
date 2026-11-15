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
  frameParts,
  fromImagePixels,
  handlePoint,
  holeCorners,
  imagePixelAt,
  imageSize,
  isDrag,
  labelPlacement,
  labelTransform,
  monitorToCss,
  moveTo,
  ratioHead,
  resizeBox,
  snapToImage,
  squareHead,
  stretch,
  surround,
  toHex,
  topmostAt,
  translate,
  withRatio,
  withSize,
  type Box,
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

describe("ratioHead", () => {
  it("holds the ratio, taking whichever side asks for the bigger box", () => {
    expect(ratioHead({ x: 0, y: 0 }, { x: 160, y: 10 }, 16 / 9)).toEqual({ x: 160, y: 90 });
    expect(ratioHead({ x: 0, y: 0 }, { x: 10, y: 90 }, 16 / 9)).toEqual({ x: 160, y: 90 });
    expect(ratioHead({ x: 200, y: 200 }, { x: 100, y: 190 }, 4 / 3)).toEqual({ x: 100, y: 125 });
  });

  it("stops growing at the edge of the bounds", () => {
    // 100 px of room below allows 160 wide at 16:10 even though the cursor asks for 300.
    expect(ratioHead({ x: 0, y: 100 }, { x: 300, y: 120 }, 1.6, { width: 1000, height: 200 })).toEqual({
      x: 160,
      y: 200,
    });
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

  it("holds a locked ratio, which Shift overrides with a square", () => {
    expect(dragBox(drag, false, undefined, 2)).toEqual({ x: 10, y: 30, width: 40, height: 20 });
    expect(dragBox({ anchor: { x: 0, y: 0 }, head: { x: 40, y: 40 } }, false, undefined, 2)).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 40,
    });
    expect(dragBox(drag, true, undefined, 2)).toEqual({ x: 10, y: 10, width: 40, height: 40 });
  });
});

describe("translate", () => {
  it("moves a box, keeping its size", () => {
    expect(translate({ x: 1, y: 2, width: 3, height: 4 }, { x: 10, y: -2 })).toEqual({
      x: 11,
      y: 0,
      width: 3,
      height: 4,
    });
  });
});

describe("handlePoint", () => {
  const box = { x: 100, y: 50, width: 200, height: 100 };

  it("puts handles on the corners and the middle of each edge", () => {
    expect(handlePoint(box, "nw")).toEqual({ x: 100, y: 50 });
    expect(handlePoint(box, "se")).toEqual({ x: 300, y: 150 });
    expect(handlePoint(box, "n")).toEqual({ x: 200, y: 50 });
    expect(handlePoint(box, "e")).toEqual({ x: 300, y: 100 });
    expect(handlePoint(box, "sw")).toEqual({ x: 100, y: 150 });
  });
});

describe("resizeBox", () => {
  const bounds = { width: 1000, height: 800 };
  const box: Box = { x: 100, y: 100, width: 200, height: 100 };
  const resize = (handle: Parameters<typeof resizeBox>[1], dx: number, dy: number, ratio?: number) =>
    resizeBox(box, handle, { x: dx, y: dy }, { bounds, ratio });

  it("moves only the edges the handle holds", () => {
    expect(resize("e", 50, 30)).toEqual({ x: 100, y: 100, width: 250, height: 100 });
    expect(resize("n", 30, -20)).toEqual({ x: 100, y: 80, width: 200, height: 120 });
    expect(resize("sw", 20, 10)).toEqual({ x: 120, y: 100, width: 180, height: 110 });
    expect(resize("ne", -50, 50)).toEqual({ x: 100, y: 150, width: 150, height: 50 });
  });

  it("turns over when pulled past the opposite edge", () => {
    expect(resize("w", 250, 0)).toEqual({ x: 300, y: 100, width: 50, height: 100 });
    expect(resize("se", -250, -150)).toEqual({ x: 50, y: 50, width: 50, height: 50 });
  });

  it("stays inside the bounds", () => {
    expect(resize("nw", -500, -500)).toEqual({ x: 0, y: 0, width: 300, height: 200 });
    expect(resize("se", 5000, 5000)).toEqual({ x: 100, y: 100, width: 900, height: 700 });
  });

  it("keeps a ratio from the opposite corner", () => {
    expect(resize("se", 100, 0, 2)).toEqual({ x: 100, y: 100, width: 300, height: 150 });
    expect(resize("nw", 0, -50, 2)).toEqual({ x: 0, y: 50, width: 300, height: 150 });
  });

  it("keeps a ratio from an edge, centred on the other axis", () => {
    expect(resize("e", 100, 0, 2)).toEqual({ x: 100, y: 75, width: 300, height: 150 });
    expect(resize("s", 0, 50, 2)).toEqual({ x: 50, y: 100, width: 300, height: 150 });
    // The box can only grow as far as its centre leaves room above and below.
    expect(
      resizeBox({ x: 0, y: 0, width: 100, height: 50 }, "e", { x: 900, y: 0 }, { bounds, ratio: 2 }),
    ).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });
});

describe("withSize", () => {
  const bounds = { width: 1000, height: 800 };

  it("keeps the top-left corner", () => {
    expect(withSize({ x: 10, y: 20, width: 5, height: 5 }, { width: 640, height: 360 }, bounds)).toEqual({
      x: 10,
      y: 20,
      width: 640,
      height: 360,
    });
  });

  it("moves back onto the screen, and is cut to it when larger", () => {
    expect(withSize({ x: 900, y: 700, width: 5, height: 5 }, { width: 640, height: 360 }, bounds)).toEqual({
      x: 360,
      y: 440,
      width: 640,
      height: 360,
    });
    expect(withSize({ x: 50, y: 50, width: 5, height: 5 }, { width: 4000, height: 100 }, bounds)).toEqual({
      x: 0,
      y: 50,
      width: 1000,
      height: 100,
    });
  });
});

describe("withRatio", () => {
  const bounds = { width: 1000, height: 800 };

  it("reshapes around the centre, keeping the width", () => {
    expect(withRatio({ x: 100, y: 100, width: 320, height: 100 }, 16 / 9, bounds)).toEqual({
      x: 100,
      y: 60,
      width: 320,
      height: 180,
    });
  });

  it("stays on the screen", () => {
    const tall = withRatio({ x: 0, y: 0, width: 1000, height: 100 }, 1, bounds);
    expect(tall).toEqual({ x: 100, y: 0, width: 800, height: 800 });
  });
});

describe("fromImagePixels", () => {
  it("covers exactly the image pixels it was made from at any scale", () => {
    for (const scale of [1, 1.25, 1.5, 2, 3]) {
      const box = fromImagePixels({ x: 37, y: 11, width: 1280, height: 720 }, scale);
      // As src-tauri's css_to_image_rect rounds: edges outwards.
      expect(Math.floor(box.x * scale)).toBe(37);
      expect(Math.floor(box.y * scale)).toBe(11);
      expect(Math.ceil((box.x + box.width) * scale)).toBe(37 + 1280);
      expect(Math.ceil((box.y + box.height) * scale)).toBe(11 + 720);
      expect(imageSize(box, scale)).toEqual({ width: 1280, height: 720 });
    }
  });
});

describe("snapToImage", () => {
  it("rounds a box onto whole image pixels, and leaves a snapped one be", () => {
    const snapped = snapToImage({ x: 10.3, y: 20.6, width: 100.4, height: 50.2 }, 2);
    expect(imageSize(snapped, 2)).toEqual({ width: 200, height: 101 });
    expect(Math.floor(snapped.x * 2)).toBe(21);
    expect(snapToImage(snapped, 2)).toEqual(snapped);
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

describe("stretch", () => {
  it("places a 1px square over a box with a transform alone", () => {
    expect(stretch({ x: 10, y: 20, width: 300, height: 40 })).toBe(
      "translate(10px, 20px) scale(300, 40)",
    );
    expect(stretch({ x: 0.125, y: 0, width: 0, height: 33.3333 })).toBe(
      "translate(0.13px, 0px) scale(0, 33.33)",
    );
  });

  it("moves a piece that keeps its size", () => {
    expect(moveTo({ x: 12.5, y: -3 })).toBe("translate(12.5px, -3px)");
  });
});

describe("surround", () => {
  const viewport = { width: 1000, height: 800 };
  const area = (boxes: { width: number; height: number }[]) =>
    boxes.reduce((sum, box) => sum + box.width * box.height, 0);

  it("covers everything around the hole and nothing of it", () => {
    const hole = { x: 100, y: 50, width: 300, height: 200 };
    expect(surround(hole, viewport)).toEqual([
      { x: 0, y: 0, width: 1000, height: 50 },
      { x: 0, y: 250, width: 1000, height: 550 },
      { x: 0, y: 50, width: 100, height: 200 },
      { x: 400, y: 50, width: 600, height: 200 },
    ]);
    expect(area(surround(hole, viewport))).toBe(1000 * 800 - 300 * 200);
  });

  it("covers the whole screen without a hole", () => {
    expect(surround(null, viewport)[0]).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
    expect(area(surround(null, viewport))).toBe(1000 * 800);
  });

  it("keeps to the screen around a window that spills off it", () => {
    const pieces = surround({ x: -50, y: 700, width: 200, height: 300 }, viewport);
    expect(pieces).toEqual([
      { x: 0, y: 0, width: 1000, height: 700 },
      { x: 0, y: 800, width: 1000, height: 0 },
      { x: 0, y: 700, width: 0, height: 100 },
      { x: 150, y: 700, width: 850, height: 100 },
    ]);
  });
});

describe("holeCorners", () => {
  it("puts a rounding piece inside each corner of the hole", () => {
    expect(holeCorners({ x: 100, y: 50, width: 300, height: 200 }, 10)).toEqual([
      { x: 100, y: 50 },
      { x: 390, y: 50 },
      { x: 100, y: 240 },
      { x: 390, y: 240 },
    ]);
  });
});

describe("frameParts", () => {
  it("draws the border just outside the selection", () => {
    const { edges } = frameParts({ x: 100, y: 50, width: 300, height: 200 });
    expect(edges).toEqual([
      { x: 99, y: 49, width: 302, height: 1 },
      { x: 99, y: 250, width: 302, height: 1 },
      { x: 99, y: 50, width: 1, height: 200 },
      { x: 400, y: 50, width: 1, height: 200 },
    ]);
  });

  it("hangs a tick on the outside of each corner", () => {
    const { ticks } = frameParts({ x: 100, y: 50, width: 300, height: 200 });
    expect(ticks).toEqual([
      { x: 97, y: 47, width: 12, height: 12 },
      { x: 391, y: 47, width: 12, height: 12 },
      { x: 97, y: 241, width: 12, height: 12 },
      { x: 391, y: 241, width: 12, height: 12 },
    ]);
  });

  it("shortens the ticks of a selection thinner than one", () => {
    const { ticks } = frameParts({ x: 100, y: 50, width: 300, height: 2 });
    expect(ticks[0]).toEqual({ x: 97, y: 47, width: 12, height: 8 });
    expect(ticks[2]).toEqual({ x: 97, y: 47, width: 12, height: 8 });
  });
});

describe("labelTransform", () => {
  const box = { x: 100, y: 50, width: 300, height: 200 };

  it("hangs the label above or below the selection, by its own height", () => {
    expect(labelTransform(box, { side: "above", align: "start" })).toBe(
      "translate(100px, 42px) translate(0, -100%)",
    );
    expect(labelTransform(box, { side: "below", align: "start" })).toBe(
      "translate(100px, 258px) translate(0, 0)",
    );
  });

  it("lines the label up with the far edge near the right of the screen", () => {
    expect(labelTransform(box, { side: "above", align: "end" })).toBe(
      "translate(400px, 42px) translate(-100%, -100%)",
    );
  });

  it("tucks the label inside a selection as tall as the screen", () => {
    expect(labelTransform(box, { side: "inside", align: "start" })).toBe(
      "translate(108px, 58px) translate(0, 0)",
    );
    expect(labelTransform(box, { side: "inside", align: "end" })).toBe(
      "translate(392px, 58px) translate(-100%, 0)",
    );
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
