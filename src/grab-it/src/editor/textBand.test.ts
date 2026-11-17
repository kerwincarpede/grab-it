import { describe, expect, it } from "vitest";
import type { PathShape } from "./model";
import { BAND_MIN_HEIGHT, BAND_REACH, bandReach, bandWindow, findTextBand, fitToBand, imageTextBand, textBand } from "./textBand";

type Color = [number, number, number];
const WHITE: Color = [255, 255, 255];
const INK: Color = [30, 30, 30];

/** A `width` by `height` capture of `background`, as ImageData would hold it. */
function capture(width: number, height: number, background: Color = WHITE) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) data.set([...background, 255], i * 4);
  const paint = (x: number, y: number, w: number, h: number, color: Color = INK) => {
    for (let row = y; row < y + h; row += 1) {
      for (let col = x; col < x + w; col += 1) data.set([...color, 255], (row * width + col) * 4);
    }
  };
  return { pixels: { width, height, data }, paint };
}

/** A line of "text": letters 6 pixels wide with 3 pixel gaps, from `x` along rows `top` to `bottom`. */
function writeLine(paint: ReturnType<typeof capture>["paint"], x: number, top: number, bottom: number, color: Color = INK) {
  for (let letter = 0; letter < 10; letter += 1) paint(x + letter * 9, top, 6, bottom - top, color);
}

describe("bandWindow", () => {
  const size = { width: 400, height: 300 };

  it("spans the drag's columns and reaches above and below its middle", () => {
    expect(bandWindow([20, 100, 120, 104], 30, size)).toEqual({ x: 20, y: 72, width: 100, height: 60 });
    // Dragged right to left, the same.
    expect(bandWindow([120, 104, 20, 100], 30, size)).toEqual({ x: 20, y: 72, width: 100, height: 60 });
  });

  it("keeps to the capture", () => {
    expect(bandWindow([-10, 10, 450, 12], 30, size)).toEqual({ x: 0, y: 0, width: 400, height: 41 });
  });

  it("leaves out drags that are steep, short or wander", () => {
    // 14° holds; 16° does not.
    expect(bandWindow([0, 100, 100, 100 + 100 * Math.tan((14 * Math.PI) / 180)], 30, size)).not.toBeNull();
    expect(bandWindow([0, 100, 100, 100 + 100 * Math.tan((16 * Math.PI) / 180)], 30, size)).toBeNull();
    expect(bandWindow([10, 10, 14, 10], 30, size)).toBeNull();
    expect(bandWindow([10, 10], 30, size)).toBeNull();
    expect(bandWindow([0, 100, 50, 140, 100, 100], 30, size)).toBeNull();
  });
});

describe("textBand", () => {
  it("finds the rows of the text under a level drag", () => {
    const { pixels, paint } = capture(200, 120);
    writeLine(paint, 20, 50, 64);
    expect(textBand(pixels, [15, 58, 110, 56], 30)).toEqual({ top: 50, bottom: 64 });
  });

  it("finds text on a dark background", () => {
    const { pixels, paint } = capture(200, 120, [24, 26, 32]);
    writeLine(paint, 20, 40, 52, [230, 230, 230]);
    expect(textBand(pixels, [20, 46, 110, 46], 30)).toEqual({ top: 40, bottom: 52 });
  });

  it("keeps the dot of an i with its line, but not the line below", () => {
    const { pixels, paint } = capture(200, 140);
    writeLine(paint, 20, 50, 64);
    // A dot one blank row above the letters.
    paint(110, 46, 3, 3);
    // The next line, three blank rows below.
    writeLine(paint, 20, 67, 81);
    expect(textBand(pixels, [15, 58, 120, 58], 40)).toEqual({ top: 46, bottom: 64 });
  });

  it("finds the line nearest the drag when the drag sits just off it", () => {
    const { pixels, paint } = capture(200, 120);
    writeLine(paint, 20, 50, 60);
    expect(textBand(pixels, [15, 66, 110, 66], 30)).toEqual({ top: 50, bottom: 60 });
  });

  it("finds nothing over a thin rule, border or underline", () => {
    const { pixels, paint } = capture(200, 120);
    paint(0, 60, 200, 1);
    expect(textBand(pixels, [15, 58, 110, 58], 30)).toBeNull();
    paint(0, 80, 200, BAND_MIN_HEIGHT - 1);
    expect(textBand(pixels, [15, 82, 110, 82], 30)).toBeNull();
  });

  it("looks for text only close to the drag", () => {
    const { pixels, paint } = capture(200, 140);
    writeLine(paint, 20, 30, 44);
    const area = { x: 15, y: 20, width: 100, height: 100 };
    // The line is 26 rows above the drag's middle: further than an eighth of the area.
    expect(findTextBand(pixels, area, 70)).toBeNull();
    expect(findTextBand(pixels, area, 70, 30)).toEqual({ top: 30, bottom: 44 });
  });

  it("finds nothing on a plain background", () => {
    const { pixels } = capture(200, 120);
    expect(textBand(pixels, [15, 58, 110, 58], 30)).toBeNull();
  });

  it("finds nothing under a picture that fills the area", () => {
    const { pixels, paint } = capture(200, 120);
    for (let row = 0; row < 120; row += 2) paint(0, row, 100, 1);
    expect(textBand(pixels, [10, 60, 90, 60], 30)).toBeNull();
  });

  it("finds nothing under a steep drag", () => {
    const { pixels, paint } = capture(200, 120);
    writeLine(paint, 20, 50, 64);
    expect(textBand(pixels, [20, 30, 60, 90], 30)).toBeNull();
  });

  it("finds nothing where canvas pixels cannot be read", () => {
    expect(imageTextBand({ width: 200, height: 120 } as HTMLImageElement, [15, 58, 110, 58], 30)).toBeNull();
  });
});

describe("fitting a highlighter", () => {
  it("looks further for a wider highlighter", () => {
    expect(bandReach(18)).toBe(BAND_REACH);
    expect(bandReach(40)).toBe(80);
  });

  it("swaps the stroke for a straight bar as tall as the band", () => {
    const shape: PathShape = { id: "h", type: "highlighter", color: "#f76b15", strokeWidth: 18, points: [110, 58, 60, 60, 15, 56] };
    expect(fitToBand(shape, { top: 50, bottom: 64 })).toEqual({ ...shape, points: [15, 57, 110, 57], strokeWidth: 14 });
  });
});
