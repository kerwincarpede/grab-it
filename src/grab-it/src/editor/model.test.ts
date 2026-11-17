import { describe, expect, it } from "vitest";
import { canvasBounds, coveredRects, isGrown, type Shape } from "./model";

const capture = { width: 400, height: 300 };
const image = (x: number, y: number, width: number, height: number): Shape => ({ id: `${x},${y}`, type: "image", src: "a.png", x, y, width, height });

describe("canvasBounds", () => {
  it("is the capture alone without images", () => {
    const arrow: Shape = { id: "a", type: "arrow", points: [-50, -50, 900, 900], color: "#f00", strokeWidth: 4 };
    expect(canvasBounds(capture, [])).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    // Annotations past the edge do not grow it; only images do.
    expect(canvasBounds(capture, [arrow])).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("grows to an image beside the capture, side by side", () => {
    expect(canvasBounds(capture, [image(400, 0, 400, 300)])).toEqual({ x: 0, y: 0, width: 800, height: 300 });
  });

  it("starts above and left of the capture for an image there, in whole pixels", () => {
    expect(canvasBounds(capture, [image(-20.5, -10.2, 60, 40), image(390, 280, 100.4, 50)])).toEqual({
      x: -21,
      y: -11,
      width: 512,
      height: 341,
    });
  });

  it("stays the capture for an image inside it, and shrinks back when it moves in", () => {
    expect(canvasBounds(capture, [image(10, 10, 100, 100)])).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});

describe("coveredRects", () => {
  it("lists the capture, then every image", () => {
    expect(coveredRects(capture, [image(400, 0, 200, 100)])).toEqual([
      { x: 0, y: 0, width: 400, height: 300 },
      { x: 400, y: 0, width: 200, height: 100 },
    ]);
  });
});

describe("isGrown", () => {
  it("tells a canvas past the capture from one inside it", () => {
    expect(isGrown({ x: 0, y: 0, width: 400, height: 300 }, capture)).toBe(false);
    expect(isGrown({ x: 10, y: 10, width: 100, height: 100 }, capture)).toBe(false);
    expect(isGrown({ x: -1, y: 0, width: 401, height: 300 }, capture)).toBe(true);
    expect(isGrown({ x: 0, y: 0, width: 800, height: 300 }, capture)).toBe(true);
  });
});
