import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUT_DEPTH,
  CUT_GAP,
  cutAnnotations,
  cutFromStrip,
  cutShift,
  edgeProfile,
  joinedImage,
  joinedSize,
  restoreStrips,
  restoreValue,
  seededRandom,
  shiftValue,
  stripBox,
  validCuts,
} from "./cut";
import type { Annotations, Cut } from "./model";
import { IDENTITY } from "./orient";

const straight: Cut = { axis: "y", start: 100, end: 160, edge: "straight" };
const zigzag: Cut = { axis: "y", start: 100, end: 160, edge: "zigzag" };

const doc: Annotations = {
  version: 1,
  shapes: [
    { id: "above", type: "rect", color: "#e5484d", strokeWidth: 4, x: 10, y: 10, width: 50, height: 40 },
    { id: "below", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [10, 200, 80, 250], control: [40, 180] },
    { id: "inside", type: "step", color: "#e5484d", x: 50, y: 130, radius: 10 },
    { id: "across", type: "rect", color: "#e5484d", strokeWidth: 4, x: 0, y: 80, width: 30, height: 120 },
    { id: "ends-in", type: "line", color: "#e5484d", strokeWidth: 4, points: [5, 50, 5, 140] },
  ],
  crop: { x: 0, y: 50, width: 400, height: 200 },
};

describe("cut out", () => {
  it("moves what is past the strip back by the strip, less the gap a jagged join leaves", () => {
    expect(cutShift(straight)).toBe(60);
    expect(cutShift(zigzag)).toBe(60 - CUT_GAP);
    expect(shiftValue(50, straight)).toBe(50);
    expect(shiftValue(200, straight)).toBe(140);
    expect(shiftValue(130, straight)).toBe(100);
    expect(joinedSize({ width: 400, height: 300 }, [straight])).toEqual({ width: 400, height: 240 });
    expect(joinedSize({ width: 400, height: 300 }, [zigzag, { axis: "x", start: 10, end: 20, edge: "straight" }])).toEqual({
      width: 390,
      height: 300 - 60 + CUT_GAP,
    });
  });

  it("shifts shapes and the crop to close the gap, removes shapes inside the strip and shortens those crossing it", () => {
    const cut = cutAnnotations(doc, straight);
    expect(cut.cuts).toEqual([straight]);
    expect(cut.shapes.map((shape) => shape.id)).toEqual(["above", "below", "across", "ends-in"]);
    expect(cut.shapes[0]).toEqual(doc.shapes[0]);
    // The control point lies past the strip as well, so it moves with the ends.
    expect(cut.shapes[1]).toMatchObject({ points: [10, 140, 80, 190], control: [40, 120] });
    expect(cut.shapes[2]).toMatchObject({ y: 80, height: 60 });
    expect(cut.shapes[3]).toMatchObject({ points: [5, 50, 5, 100] });
    // The crop shrinks by its overlap with the strip.
    expect(cut.crop).toEqual({ x: 0, y: 50, width: 400, height: 140 });
  });

  it("drops a crop that lies wholly inside the strip", () => {
    expect(cutAnnotations({ ...doc, crop: { x: 0, y: 110, width: 40, height: 30 } }, straight).crop).toBeNull();
  });

  it("keeps a lens square and moves its spot", () => {
    const lens: Annotations = {
      version: 1,
      shapes: [{ id: "m", type: "magnify", color: "#e5484d", strokeWidth: 4, x: 10, y: 200, width: 40, height: 40, spot: [30, 280], zoom: 2 }],
    };
    expect(cutAnnotations(lens, straight).shapes[0]).toMatchObject({ y: 140, width: 40, height: 40, spot: [30, 220] });
  });

  it("shifts along x for a vertical strip", () => {
    const cut: Cut = { axis: "x", start: 20, end: 40, edge: "straight" };
    const shifted = cutAnnotations(doc, cut);
    expect(shifted.shapes.find((shape) => shape.id === "below")).toMatchObject({ points: [10, 200, 60, 250], control: [20, 180] });
    expect(shifted.crop).toEqual({ x: 0, y: 50, width: 380, height: 200 });
  });

  it("restores every strip last to first, leaving shortened and removed shapes as they are", () => {
    const second: Cut = { axis: "x", start: 150, end: 170, edge: "torn", seed: 7 };
    const cut = cutAnnotations(cutAnnotations(doc, zigzag), second);
    const restored = restoreStrips(cut);
    expect(restored).not.toHaveProperty("cuts");
    expect(restored.shapes.find((shape) => shape.id === "below")).toEqual(doc.shapes[1]);
    expect(restored.shapes.find((shape) => shape.id === "above")).toEqual(doc.shapes[0]);
    expect(restored.shapes.find((shape) => shape.id === "inside")).toBeUndefined();
    // Clamped to the join, it stays there.
    expect(restored.shapes.find((shape) => shape.id === "ends-in")).toMatchObject({ points: [5, 50, 5, 100] });
    expect(restored.crop).toEqual(doc.crop);
    expect(restoreValue(100, straight)).toBe(100);
    expect(restoreValue(101, straight)).toBe(161);
  });

  it("leaves a document without cuts alone on restore", () => {
    expect(restoreStrips(doc)).toBe(doc);
  });

  it("draws a torn edge the same way every time from its seed, within the depth", () => {
    expect(seededRandom(3)()).toBe(seededRandom(3)());
    const torn = edgeProfile({ edge: "torn", seed: 42 }, 200);
    expect(edgeProfile({ edge: "torn", seed: 42 }, 200)).toEqual(torn);
    expect(edgeProfile({ edge: "torn", seed: 43 }, 200)).not.toEqual(torn);
    expect(torn.every(([, depth]) => depth >= 0 && depth <= CUT_DEPTH)).toBe(true);
    expect(torn[torn.length - 1][0]).toBe(200);
    const teeth = edgeProfile({ edge: "zigzag" }, 50);
    expect(teeth.slice(0, 3)).toEqual([[0, 0], [CUT_DEPTH, CUT_DEPTH], [2 * CUT_DEPTH, 0]]);
    expect(teeth[teeth.length - 1][0]).toBe(50);
    expect(edgeProfile({ edge: "straight" }, 50)).toEqual([]);
  });

  it("marks a strip across the whole image on show", () => {
    expect(stripBox(120, 80, "horizontal", { width: 400, height: 300 })).toEqual({ x: 0, y: 80, width: 400, height: 40 });
    expect(stripBox(-10, 30.4, "vertical", { width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 30, height: 300 });
  });

  it("turns a strip on show into a cut in image pixels, as the capture shows", () => {
    const size = { width: 400, height: 300 };
    expect(cutFromStrip({ x: 0, y: 100, width: 400, height: 60 }, size, IDENTITY, "straight")).toEqual(straight);
    // Turned a quarter right, a horizontal strip on show runs down the capture: it removes columns.
    const turned = { rotation: 90 as const, flipX: false, flipY: false };
    expect(cutFromStrip({ x: 0, y: 100, width: 300, height: 60 }, size, turned, "zigzag")).toEqual({ axis: "x", start: 100, end: 160, edge: "zigzag" });
    expect(cutFromStrip({ x: 0, y: 100, width: 400, height: 60 }, size, IDENTITY, "torn", 9)).toMatchObject({ edge: "torn", seed: 9 });
    // Too thin, or leaving nothing on one side.
    expect(cutFromStrip({ x: 0, y: 100, width: 400, height: 2 }, size, IDENTITY, "straight")).toBeNull();
    expect(cutFromStrip({ x: 0, y: 0, width: 400, height: 60 }, size, IDENTITY, "straight")).toBeNull();
    expect(cutFromStrip({ x: 0, y: 250, width: 400, height: 50 }, size, IDENTITY, "straight")).toBeNull();
  });

  it("shows the image itself without cuts, and a canvas of the joined size with them", () => {
    const image = { width: 400, height: 300 } as unknown as HTMLImageElement;
    expect(joinedImage(image, undefined)).toBe(image);
    expect(joinedImage(image, [])).toBe(image);
    const joined = joinedImage(image, [straight]);
    expect([joined.width, joined.height]).toEqual([400, 240]);
  });

  it("keeps a crop the cut leaves only a pixel or two of", () => {
    expect(cutAnnotations({ ...doc, crop: { x: 0, y: 150, width: 400, height: 12 } }, straight).crop).toEqual({ x: 0, y: 100, width: 400, height: 2 });
    expect(cutAnnotations({ ...doc, crop: { x: 0, y: 159, width: 400, height: 2 } }, straight).crop).toEqual({ x: 0, y: 100, width: 400, height: 1 });
  });

  it("puts back a shape flush with the end of a jagged strip on restore", () => {
    const flush: Annotations = {
      version: 1,
      shapes: [{ id: "flush", type: "rect", color: "#e5484d", strokeWidth: 4, x: 10, y: 160, width: 50, height: 40 }],
      crop: { x: 0, y: 160, width: 400, height: 40 },
    };
    const cut = cutAnnotations(flush, zigzag);
    expect(cut.shapes[0]).toMatchObject({ y: 108, height: 40 });
    expect(cut.crop).toEqual({ x: 0, y: 108, width: 400, height: 40 });
    const restored = restoreStrips(cut);
    expect(restored.shapes[0]).toMatchObject({ y: 160, height: 40 });
    expect(restored.crop).toEqual(flush.crop);
  });

  it("leaves out stored cuts that do not fit the image the earlier cuts left", () => {
    const size = { width: 400, height: 200 };
    const tooLong: Cut = { axis: "y", start: 100, end: 1000, edge: "straight" };
    // Fits the capture, but not what the first cut leaves.
    const pastFirst: Cut = { axis: "y", start: 120, end: 160, edge: "straight" };
    const first: Cut = { axis: "y", start: 20, end: 80, edge: "straight" };
    expect(validCuts(size, [tooLong, first, pastFirst])).toEqual([first]);
    expect(joinedSize(size, [tooLong])).toEqual(size);
    expect(joinedSize(size, [first, pastFirst])).toEqual({ width: 400, height: 140 });
    const image = { width: 400, height: 200 } as unknown as HTMLImageElement;
    expect(joinedImage(image, [tooLong])).toBe(image);
  });
});

describe("joining the parts", () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Joins a capture `width` × `height` whose every pixel holds its row, and
   * returns, per column, the source row drawn at each joined row (null for a
   * see-through one).
   */
  function rows(width: number, height: number, cut: Cut): (number | null)[][] {
    const out = joinedSize({ width, height }, [cut]);
    const columns: (number | null)[][] = Array.from({ length: out.width }, () => Array<number | null>(out.height).fill(null));
    const context = {
      drawImage: (_: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) => {
        expect([dw, dh]).toEqual([sw, sh]);
        for (let x = 0; x < sw; x++) for (let y = 0; y < sh; y++) columns[dx + x][dy + y] = sy + y;
        expect(sx).toBe(dx);
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    joinedImage({ width, height } as unknown as HTMLImageElement, [cut]);
    return columns;
  }

  it.each([zigzag, { ...zigzag, edge: "torn" as const, seed: 42 }])("leaves exactly the gap between matching $edge edges", (cut) => {
    const shift = cutShift(cut);
    for (const column of rows(60, 300, cut)) {
      const empty = column.flatMap((row, y) => (row === null ? [y] : []));
      expect(empty).toHaveLength(CUT_GAP);
      const top = empty[0];
      expect(empty).toEqual(Array.from({ length: CUT_GAP }, (_, i) => top + i));
      // The part before keeps everything up to its jagged edge, the part after starts on the same line.
      expect(top).toBeGreaterThan(cut.start - CUT_DEPTH - 1);
      expect(top).toBeLessThanOrEqual(cut.start);
      column.forEach((row, y) => {
        if (y < top) expect(row).toBe(y);
        else if (y >= top + CUT_GAP) expect(row).toBe(y + shift);
      });
    }
  });

  it("joins a straight cut seamlessly", () => {
    for (const column of rows(20, 300, straight)) expect(column).toEqual([...Array.from({ length: 100 }, (_, y) => y), ...Array.from({ length: 140 }, (_, y) => y + 160)]);
  });
});
