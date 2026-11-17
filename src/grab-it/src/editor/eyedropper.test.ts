import { afterEach, describe, expect, it, vi } from "vitest";
import { capturePixel, pixelColor } from "./eyedropper";

describe("eyedropper", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("finds the capture pixel under the pointer, and none off the capture", () => {
    const size = { width: 400, height: 300 };
    expect(capturePixel({ x: 12.7, y: 34.2 }, size)).toEqual({ x: 12, y: 34 });
    expect(capturePixel({ x: 399.9, y: 299.9 }, size)).toEqual({ x: 399, y: 299 });
    expect(capturePixel({ x: -0.5, y: 10 }, size)).toBeNull();
    expect(capturePixel({ x: 10, y: 300 }, size)).toBeNull();
  });

  it("reads one pixel's colour as lower-case hex", () => {
    const context = {
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([26, 43, 60, 255]) })),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    const image = {} as CanvasImageSource;
    expect(pixelColor(image, { x: 5, y: 7 })).toBe("#1a2b3c");
    expect(context.drawImage).toHaveBeenCalledWith(image, 5, 7, 1, 1, 0, 0, 1, 1);
  });

  it("gives no colour where the canvas cannot be read", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(pixelColor({} as CanvasImageSource, { x: 0, y: 0 })).toBeNull();
  });
});
