import { describe, expect, it } from "vitest";
import { EDGE_SCAN_SIZE, findEdges, orientEdges, type Pixels } from "./edges";

/** Synthetic RGBA pixels, gray `shade(x, y)` everywhere. */
function pixels(width: number, height: number, shade: (x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      const value = shade(x, y);
      data.set([value, value, value, 255], at);
    }
  }
  return { width, height, data };
}

/** A white capture with a dark panel over `[left, right) × [top, bottom)`. */
const panel = (width: number, height: number, left: number, top: number, right: number, bottom: number) =>
  pixels(width, height, (x, y) => (x >= left && x < right && y >= top && y < bottom ? 30 : 250));

/** A repeatable pseudo-random sequence in [0, 1). */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("findEdges", () => {
  it("finds a panel's borders, where its first and past-last pixels are", () => {
    expect(findEdges(panel(100, 80, 20, 10, 60, 50))).toEqual({ x: [20, 60], y: [10, 50] });
  });

  it("looks on a downscaled copy but answers in capture pixels", () => {
    expect(EDGE_SCAN_SIZE).toBe(512);
    expect(findEdges(panel(1024, 512, 256, 128, 768, 384))).toEqual({ x: [256, 768], y: [128, 384] });
  });

  it("maps lines from a smaller copy onto the capture it shows", () => {
    expect(findEdges(panel(100, 80, 20, 10, 60, 50), { width: 200, height: 160 })).toEqual({ x: [40, 120], y: [20, 100] });
  });

  it("ignores a line too short to be a border", () => {
    // 20 of 100 rows (20%) step across the panel's sides.
    expect(findEdges(panel(100, 100, 20, 40, 60, 60)).x).toEqual([]);
  });

  it("keeps only the strongest of neighbouring lines", () => {
    // A two-step edge: every row steps at x 10, only the top half at x 11.
    const soft = pixels(40, 40, (x, y) => (x < 10 ? 0 : x === 10 ? 200 : y < 20 ? 255 : 200));
    expect(findEdges(soft).x).toEqual([10]);
  });

  it("finds nothing in faint noise or scattered specks", () => {
    const faint = random(1);
    expect(findEdges(pixels(120, 90, () => 128 + Math.round((faint() - 0.5) * 24)))).toEqual({ x: [], y: [] });
    const specks = random(7);
    expect(findEdges(pixels(120, 90, () => (specks() < 0.05 ? 0 : 255)))).toEqual({ x: [], y: [] });
  });

  it("still finds a panel through faint noise", () => {
    const faint = random(3);
    const noisy = pixels(100, 80, (x, y) => (x >= 20 && x < 60 && y >= 10 && y < 50 ? 30 : 250) + Math.round((faint() - 0.5) * 10));
    expect(findEdges(noisy)).toEqual({ x: [20, 60], y: [10, 50] });
  });

  it("finds nothing in a flat image or a single pixel", () => {
    expect(findEdges(pixels(64, 48, () => 200))).toEqual({ x: [], y: [] });
    expect(findEdges(pixels(1, 1, () => 0))).toEqual({ x: [], y: [] });
  });
});

describe("orientEdges", () => {
  const size = { width: 400, height: 300 };
  const edges = { x: [100], y: [80] };

  it("leaves lines alone when the capture is not turned", () => {
    expect(orientEdges(edges, size, { rotation: 0, flipX: false, flipY: false })).toEqual(edges);
  });

  it("swaps vertical and horizontal lines for a quarter turn", () => {
    // Turned right, the capture shows 300 wide: its top edge is on the right.
    expect(orientEdges(edges, size, { rotation: 90, flipX: false, flipY: false })).toEqual({ x: [220], y: [100] });
    expect(orientEdges(edges, size, { rotation: 270, flipX: false, flipY: false })).toEqual({ x: [80], y: [300] });
  });

  it("mirrors lines to the far side for a flip", () => {
    expect(orientEdges(edges, size, { rotation: 0, flipX: true, flipY: false })).toEqual({ x: [300], y: [80] });
    expect(orientEdges(edges, size, { rotation: 180, flipX: false, flipY: false })).toEqual({ x: [300], y: [220] });
  });
});
