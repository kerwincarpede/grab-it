import { describe, expect, it } from "vitest";
import { blurPixels, shadePixels } from "./backdrop";

/** An RGBA image of `width` by `height` whose every pixel is `grey`. */
function flat(width: number, height: number, grey: number) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([grey, grey, grey, 255], i);
  return data;
}

const red = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  data[(y * width + x) * 4];

describe("blurPixels", () => {
  it("leaves a flat image as it is", () => {
    const data = flat(9, 7, 120);
    blurPixels(data, 9, 7);
    expect(Array.from(new Set(data))).toEqual([120, 255]);
  });

  it("spreads a bright pixel over its neighbours, keeping the light", () => {
    const width = 21;
    const data = flat(width, width, 0);
    data[(10 * width + 10) * 4] = 255;
    blurPixels(data, width, width, 2, 3);
    const centre = red(data, width, 10, 10);
    expect(centre).toBeGreaterThan(0);
    expect(centre).toBeLessThan(255);
    expect(red(data, width, 12, 10)).toBeGreaterThan(0);
    expect(red(data, width, 10, 12)).toBeGreaterThan(0);
    // Too far for three 5 px boxes to reach.
    expect(red(data, width, 17, 10)).toBe(0);
    let total = 0;
    for (let i = 0; i < data.length; i += 4) total += data[i];
    expect(total).toBeGreaterThan(200);
    expect(total).toBeLessThan(310);
  });

  it("keeps alpha untouched", () => {
    const data = flat(5, 5, 50);
    data[3] = 10;
    blurPixels(data, 5, 5, 1, 1);
    expect(data[3]).toBe(10);
  });

  it("ignores a buffer smaller than the image", () => {
    const data = flat(2, 2, 90);
    blurPixels(data, 10, 10);
    expect(Array.from(data.slice(0, 4))).toEqual([90, 90, 90, 255]);
  });
});

describe("shadePixels", () => {
  it("darkens towards near black, as the overlay's wash did", () => {
    const data = flat(1, 1, 255);
    shadePixels(data);
    // 255 × 0.48 + 8 × 0.52, and so on.
    expect(Array.from(data)).toEqual([127, 127, 129, 255]);
  });

  it("takes a little of the colour out", () => {
    const data = new Uint8ClampedArray([200, 0, 0, 255]);
    shadePixels(data);
    const plain = 200 * 0.48 + 8 * 0.52;
    expect(data[0]).toBeLessThan(plain);
    expect(data[1]).toBeGreaterThan(9 * 0.52);
  });
});
