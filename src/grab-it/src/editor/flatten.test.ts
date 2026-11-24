import Konva from "konva";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Layer, Stage } from "react-konva";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  angleLine,
  backdropLayout,
  backdropPaint,
  blurArea,
  blurredGeometry,
  BLURRED_SIZE,
  composeBackdrop,
  coverCrop,
  exportArea,
  exportMime,
  exportsOnWhite,
  exportTarget,
  flatten,
  gradientStops,
  NO_BORDERS,
  paintBackdrop,
  plainBorders,
  reachesPast,
  shadowPlate,
  shadowShift,
  resample,
  type PaintLayer,
} from "./flatten";
import { backdropColors, canvasBounds, sameBackdrop, type Backdrop, type MagnifyShape, type LineShape, type Shape, type StampShape } from "./model";
import ShapeNode from "./ShapeNode";
import { ARROW_STYLES } from "./arrowStyles";
import { magnifyLinePoints, magnifyScene } from "./magnify";

describe("flatten", () => {
  it("maps the crop to stage pixels at capture resolution", () => {
    expect(exportArea({ x: 10, y: 20, width: 100, height: 50 }, { width: 400, height: 300 }, { scale: 0.5, x: 30, y: 40 })).toEqual({
      x: 35,
      y: 50,
      width: 50,
      height: 25,
      pixelRatio: 2,
    });
  });

  it("exports the whole capture without a crop", () => {
    expect(exportArea(null, { width: 400, height: 300 }, { scale: 2, x: -100, y: 0 })).toEqual({
      x: -100,
      y: 0,
      width: 800,
      height: 600,
      pixelRatio: 0.5,
    });
  });

  it("exports the crop as it shows once rotated", () => {
    // A 400×300 capture turned right shows 300×400; the crop turns with it.
    expect(
      exportArea({ x: 10, y: 20, width: 100, height: 50 }, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, { rotation: 90, flipX: false, flipY: false }),
    ).toEqual({ x: 230, y: 10, width: 50, height: 100, pixelRatio: 1 });
    expect(
      exportArea(null, { width: 400, height: 300 }, { scale: 0.5, x: 10, y: 0 }, { rotation: 270, flipX: true, flipY: false }),
    ).toEqual({ x: 10, y: 0, width: 150, height: 200, pixelRatio: 2 });
  });

  it("exports a canvas grown past the capture by added images", () => {
    // A 400×300 capture with images above-left and to the right of it.
    const canvas = canvasBounds({ width: 400, height: 300 }, [
      { id: "l", type: "image", src: "left.png", x: -50, y: -20, width: 60, height: 40 },
      { id: "r", type: "image", src: "right.png", x: 400, y: 0, width: 400, height: 300 },
    ]);
    expect(canvas).toEqual({ x: -50, y: -20, width: 850, height: 320 });
    expect(exportArea(canvas, { width: 400, height: 300 }, { scale: 0.5, x: 100, y: 50 })).toEqual({
      x: 75,
      y: 40,
      width: 425,
      height: 160,
      pixelRatio: 2,
    });
  });

  it("exports the whole canvas when there is no crop", () => {
    const canvas = { x: -50, y: 0, width: 850, height: 300 };
    expect(exportArea(null, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, undefined, canvas)).toEqual({
      x: -50,
      y: 0,
      width: 850,
      height: 300,
      pixelRatio: 1,
    });
    // A crop still wins, and a turned canvas turns about the capture.
    expect(exportArea({ x: 0, y: 0, width: 10, height: 10 }, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, undefined, canvas)).toMatchObject({
      width: 10,
      height: 10,
    });
    expect(exportArea(null, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, { rotation: 90, flipX: false, flipY: false }, canvas)).toEqual({
      x: 0,
      y: -50,
      width: 300,
      height: 850,
      pixelRatio: 1,
    });
  });

  it("tells an area past the capture, which may have clear parts", () => {
    const capture = { width: 400, height: 300 };
    expect(reachesPast({ x: 10, y: 10, width: 100, height: 100 }, capture)).toBe(false);
    expect(reachesPast({ x: 0, y: 0, width: 400, height: 300 }, capture)).toBe(false);
    expect(reachesPast({ x: 0, y: 0, width: 600, height: 300 }, capture)).toBe(true);
    expect(reachesPast({ x: -1, y: 0, width: 100, height: 100 }, capture)).toBe(true);
    // Turned, the capture shows 300×400.
    expect(reachesPast({ x: 0, y: 0, width: 300, height: 400 }, capture, { rotation: 90, flipX: false, flipY: false })).toBe(false);
    expect(reachesPast({ x: 0, y: 0, width: 400, height: 300 }, capture, { rotation: 90, flipX: false, flipY: false })).toBe(true);
  });

  it("makes the shadow's silhouette from the content's own alpha", () => {
    // A 4×1 strip: opaque, half see-through, clear (an image's transparent margin), opaque.
    const alpha = [1, 0.5, 0, 1];
    const pixels = new WeakMap<object, { alpha: number[]; color: string[] }>();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
      const own = { alpha: new Array(this.width).fill(0), color: new Array(this.width).fill("") };
      pixels.set(this, own);
      const ctx = {
        globalCompositeOperation: "source-over",
        fillStyle: "",
        beginPath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        arcTo: () => undefined,
        closePath: () => undefined,
        clip: () => undefined,
        drawImage: (source: { alpha: number[] }) => {
          source.alpha.forEach((a, x) => {
            own.alpha[x] = a + own.alpha[x] * (1 - a);
            own.color[x] = "content";
          });
        },
        // Only `source-in` is used: the colour, kept to what is already there.
        fillRect: () => {
          if (ctx.globalCompositeOperation !== "source-in") throw new Error("the plate must keep the content's alpha");
          own.color = own.color.map((_, x) => (own.alpha[x] > 0 ? ctx.fillStyle : ""));
        },
      };
      return ctx as unknown as CanvasRenderingContext2D;
    } as never);
    try {
      const plate = shadowPlate({ alpha } as unknown as CanvasImageSource, { width: 4, height: 1 }, 0);
      expect(plate).not.toBeNull();
      const drawn = pixels.get(plate as HTMLCanvasElement);
      // Black only where there are pixels, and only as solid as they are: nothing under the clear margin.
      expect(drawn?.alpha).toEqual([1, 0.5, 0, 1]);
      expect(drawn?.color).toEqual(["#000000", "#000000", "", "#000000"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("blurs only the part of the area over the capture", () => {
    expect(blurArea({ x: -100, y: 0, width: 900, height: 300 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(blurArea({ x: 300, y: 50, width: 400, height: 100 }, { width: 400, height: 300 })).toEqual({ x: 300, y: 50, width: 100, height: 100 });
    // An area all past the capture blurs the whole capture.
    expect(blurArea({ x: 500, y: 0, width: 100, height: 100 }, { width: 400, height: 300 })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("picks PNG or JPG from the file name", () => {
    expect(exportTarget("/tmp/a.JPG")).toEqual({ path: "/tmp/a.JPG", format: "jpg" });
    expect(exportTarget("/tmp/a.jpeg")).toEqual({ path: "/tmp/a.jpeg", format: "jpg" });
    expect(exportTarget("/tmp/a.png")).toEqual({ path: "/tmp/a.png", format: "png" });
    expect(exportTarget("/tmp/a")).toEqual({ path: "/tmp/a.png", format: "png" });
  });

  it("picks WebP, GIF, TIFF, BMP or PDF from the file name, whatever its case", () => {
    expect(exportTarget("/tmp/a.webp")).toEqual({ path: "/tmp/a.webp", format: "webp" });
    expect(exportTarget("/tmp/a.GIF")).toEqual({ path: "/tmp/a.GIF", format: "gif" });
    expect(exportTarget("/tmp/a.tif")).toEqual({ path: "/tmp/a.tif", format: "tiff" });
    expect(exportTarget("/tmp/a.TIFF")).toEqual({ path: "/tmp/a.TIFF", format: "tiff" });
    expect(exportTarget("/tmp/a.bmp")).toEqual({ path: "/tmp/a.bmp", format: "bmp" });
    expect(exportTarget("/tmp/a.Pdf")).toEqual({ path: "/tmp/a.Pdf", format: "pdf" });
    // An unknown ending is kept and saved as PNG.
    expect(exportTarget("/tmp/a.heic")).toEqual({ path: "/tmp/a.heic.png", format: "png" });
  });

  it("sends a PNG for every format but JPEG, on white where the format has no transparency", () => {
    const formats = ["png", "jpg", "webp", "gif", "tiff", "bmp", "pdf"] as const;
    expect(formats.map(exportMime)).toEqual(["image/png", "image/jpeg", "image/png", "image/png", "image/png", "image/png", "image/png"]);
    expect(formats.filter(exportsOnWhite)).toEqual(["jpg", "gif", "bmp", "pdf"]);
  });
});

describe("backdrop", () => {
  const backdrop: Backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true };
  const size = { width: 400, height: 300 };

  it("leaves the capture as the output without a backdrop", () => {
    expect(backdropLayout(size, null)).toEqual({ width: 400, height: 300, x: 0, y: 0, radius: 0, shadow: null });
  });

  it("grows the output by the padding on every side", () => {
    expect(backdropLayout(size, backdrop)).toMatchObject({ width: 528, height: 428, x: 64, y: 64, radius: 12 });
    expect(backdropLayout(size, { ...backdrop, padding: 0 })).toMatchObject({ width: 400, height: 300, x: 0, y: 0 });
  });

  it("lays out the cropped size, not the whole capture", () => {
    expect(backdropLayout({ width: 100, height: 50 }, { ...backdrop, padding: 20 })).toMatchObject({ width: 140, height: 90, x: 20, y: 20 });
  });

  it("keeps padding to whole pixels so the capture is not resampled", () => {
    expect(backdropLayout(size, { ...backdrop, padding: 10.6 })).toMatchObject({ width: 422, x: 11, y: 11 });
  });

  it("never rounds corners past half the shorter side", () => {
    expect(backdropLayout({ width: 200, height: 40 }, { ...backdrop, radius: 48 }).radius).toBe(20);
  });

  it("casts a shadow only when asked, scaled to the capture", () => {
    expect(backdropLayout(size, { ...backdrop, shadow: false }).shadow).toBeNull();
    expect(backdropLayout(size, backdrop).shadow).toEqual({ blur: 18, offsetY: 6, opacity: 0.35 });
    // Small captures still get a visible shadow.
    expect(backdropLayout({ width: 40, height: 40 }, backdrop).shadow?.blur).toBe(12);
  });

  it("paints presets as gradients and anything else as a solid colour", () => {
    expect(backdropColors("ocean").length).toBeGreaterThan(1);
    expect(backdropColors("#ffffff")).toEqual(["#ffffff"]);
    expect(gradientStops(["#000000", "#888888", "#ffffff"])).toEqual([0, "#000000", 0.5, "#888888", 1, "#ffffff"]);
    expect(gradientStops(["#000000"])).toEqual([0, "#000000"]);
  });

  it("compares backdrops by value", () => {
    expect(sameBackdrop(backdrop, { ...backdrop })).toBe(true);
    expect(sameBackdrop(backdrop, { ...backdrop, padding: 65 })).toBe(false);
    expect(sameBackdrop(null, undefined)).toBe(true);
    expect(sameBackdrop(backdrop, null)).toBe(false);
    // A missing balance is balance off.
    expect(sameBackdrop(backdrop, { ...backdrop, balance: false })).toBe(true);
    expect(sameBackdrop(backdrop, { ...backdrop, balance: true })).toBe(false);
  });
});

describe("backdrop shape", () => {
  const backdrop: Backdrop = { fill: "ocean", padding: 64, radius: 36, radiusUnit: "pt", shadow: true };
  const size = { width: 400, height: 300 };

  it("turns the corner radius from points into pixels with the scale factor", () => {
    expect(backdropLayout(size, backdrop, 2).radius).toBe(72);
    expect(backdropLayout(size, backdrop, 1).radius).toBe(36);
    // Points × scale still never passes half the shorter side.
    expect(backdropLayout({ width: 100, height: 100 }, { ...backdrop, radius: 80 }, 2).radius).toBe(50);
    // A nonsense scale counts as 1.
    expect(backdropLayout(size, backdrop, 0).radius).toBe(36);
    expect(backdropLayout(size, backdrop, Number.NaN).radius).toBe(36);
  });

  it("keeps an older sidecar's radius in pixels, whatever the scale", () => {
    const old: Backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true };
    expect(backdropLayout(size, old, 2).radius).toBe(12);
    expect(backdropLayout(size, old, 1).radius).toBe(12);
  });

  it("pads one axis further to reach the aspect ratio, keeping the capture centred", () => {
    // 528×428 padded evenly.
    expect(backdropLayout(size, { ...backdrop, aspect: "auto" })).toMatchObject({ width: 528, height: 428, x: 64, y: 64 });
    expect(backdropLayout(size, { ...backdrop, aspect: "16:9" })).toMatchObject({ width: 761, height: 428, x: 181, y: 64 });
    expect(backdropLayout(size, { ...backdrop, aspect: "4:3" })).toMatchObject({ width: 571, height: 428, x: 86, y: 64 });
    expect(backdropLayout(size, { ...backdrop, aspect: "1:1" })).toMatchObject({ width: 528, height: 528, x: 64, y: 114 });
    // 9:16, for phones, grows a landscape capture downwards.
    expect(backdropLayout(size, { ...backdrop, aspect: "9:16" })).toMatchObject({ width: 528, height: 939, x: 64, y: 320 });
    // A tall capture grows sideways for 16:9, a wide one grows downwards for 1:1.
    expect(backdropLayout({ width: 100, height: 400 }, { ...backdrop, padding: 0, aspect: "16:9" })).toMatchObject({ width: 711, height: 400, x: 306, y: 0 });
    expect(backdropLayout({ width: 400, height: 100 }, { ...backdrop, padding: 0, aspect: "1:1" })).toMatchObject({ width: 400, height: 400, x: 0, y: 150 });
  });

  it("gives old shadow-on sidecars the shadow they always had", () => {
    const old = { fill: "ocean", padding: 64, radius: 12, shadow: true };
    expect(backdropLayout(size, old).shadow).toEqual({ blur: 18, offsetY: 6, opacity: 0.35 });
    expect(backdropLayout(size, { ...old, shadowSize: 50, shadowStrength: 35 }).shadow).toEqual({ blur: 18, offsetY: 6, opacity: 0.35 });
  });

  it("sizes and strengthens the shadow from its sliders", () => {
    expect(backdropLayout(size, { ...backdrop, shadowSize: 100 }).shadow).toEqual({ blur: 36, offsetY: 12, opacity: 0.35 });
    expect(backdropLayout(size, { ...backdrop, shadowSize: 0 }).shadow).toEqual({ blur: 0, offsetY: 0, opacity: 0.35 });
    expect(backdropLayout(size, { ...backdrop, shadowStrength: 80 }).shadow?.opacity).toBe(0.8);
    // No strength is no shadow.
    expect(backdropLayout(size, { ...backdrop, shadowStrength: 0 }).shadow).toBeNull();
    expect(backdropLayout(size, { ...backdrop, shadow: false, shadowSize: 80 }).shadow).toBeNull();
  });
});

describe("backdrop fills", () => {
  const base: Backdrop = { fill: "ocean", padding: 64, radius: 36, shadow: true };
  const size = { width: 200, height: 100 };

  it("paints presets corner to corner, as before", () => {
    expect(backdropPaint(base, size)).toEqual([
      { kind: "linear", start: { x: 0, y: 0 }, end: { x: 200, y: 100 }, stops: [0, "#4c8dff", 1, "#7b5cff"] },
    ]);
    expect(backdropPaint({ ...base, fill: "lagoon" }, size)[0]).toMatchObject({ kind: "linear", stops: [0, "#00c6fb", 0.5, "#3ddc97", 1, "#f9f871"] });
    expect(backdropPaint({ ...base, fill: "#ffffff" }, size)).toEqual([{ kind: "solid", color: "#ffffff" }]);
  });

  it("paints a mesh as soft blobs over its base colour", () => {
    const layers = backdropPaint({ ...base, fill: "mesh-bloom" }, size);
    expect(layers[0]).toEqual({ kind: "solid", color: "#ffb6c9" });
    expect(layers).toHaveLength(4);
    expect(layers[1]).toEqual({ kind: "radial", center: { x: 0, y: 0 }, radius: 180, stops: [0, "#ffd36e", 1, "#ffd36e00"] });
    expect(layers[2]).toMatchObject({ kind: "radial", center: { x: 200, y: 20 } });
  });

  it("paints nothing for transparent, and an underlay beneath the blurred capture and the image", () => {
    expect(backdropPaint({ ...base, fill: "transparent" }, size)).toEqual([]);
    expect(backdropPaint({ ...base, fill: "blur" }, size).map((layer) => layer.kind)).toEqual(["solid", "blurred"]);
    expect(backdropPaint({ ...base, fill: "image", image: "/a.png" }, size).map((layer) => layer.kind)).toEqual(["solid", "image"]);
  });

  it("paints the custom gradient at its CSS angle", () => {
    const [layer] = backdropPaint({ ...base, fill: "custom", gradient: { from: "#000000", to: "#ffffff", angle: 90 } }, size);
    expect(layer).toMatchObject({ kind: "linear", stops: [0, "#000000", 1, "#ffffff"] });
    const line = layer as Extract<PaintLayer, { kind: "linear" }>;
    expect(line.start.x).toBeCloseTo(0);
    expect(line.start.y).toBeCloseTo(50);
    expect(line.end.x).toBeCloseTo(200);
    expect(line.end.y).toBeCloseTo(50);
    // Without its own colours, the default gradient.
    expect(backdropPaint({ ...base, fill: "custom" }, size)[0]).toMatchObject({ stops: [0, "#4c8dff", 1, "#ff6ac1"] });
  });

  it("runs CSS angles the way CSS does", () => {
    const toBottom = angleLine(180, 200, 100);
    expect(toBottom.start.x).toBeCloseTo(100);
    expect(toBottom.start.y).toBeCloseTo(0);
    expect(toBottom.end.y).toBeCloseTo(100);
    const toTop = angleLine(0, 200, 100);
    expect(toTop.start.y).toBeCloseTo(100);
    expect(toTop.end.y).toBeCloseTo(0);
    // Diagonals reach past the corners so the end colours land on them.
    const diagonal = angleLine(45, 100, 100);
    expect(diagonal.end.x - diagonal.start.x).toBeCloseTo(100);
  });

  it("covers like CSS background-size: cover", () => {
    const rounded = (rect: { x: number; y: number; width: number; height: number }) =>
      Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 1000) / 1000]));
    expect(rounded(coverCrop({ x: 0, y: 0, width: 400, height: 300 }, { width: 160, height: 90 }))).toEqual({ x: 0, y: 37.5, width: 400, height: 225 });
    expect(rounded(coverCrop({ x: 0, y: 0, width: 400, height: 300 }, { width: 100, height: 100 }))).toEqual({ x: 50, y: 0, width: 300, height: 300 });
    // A crop of the capture is covered from within the crop.
    expect(rounded(coverCrop({ x: 10, y: 20, width: 100, height: 100 }, { width: 200, height: 100 }))).toEqual({ x: 10, y: 45, width: 100, height: 50 });
  });

  it("blurs the capture small, with a margin that hides the blur's soft edges", () => {
    const geometry = blurredGeometry({ width: 1600, height: 800 });
    expect(geometry.crop).toEqual({ x: geometry.blur * 2, y: geometry.blur * 2, width: BLURRED_SIZE, height: 160 });
    expect(geometry.canvas).toEqual({ width: BLURRED_SIZE + geometry.blur * 4, height: 160 + geometry.blur * 4 });
    expect(geometry.blur).toBe(16);
    // Small outputs are not enlarged.
    expect(blurredGeometry({ width: 100, height: 50 }).crop).toMatchObject({ width: 100, height: 50 });
  });
});

/** A 2D context that records what is drawn. */
function recordingContext() {
  const calls: unknown[][] = [];
  const gradient = (kind: string, args: unknown[]) => {
    const stops: unknown[] = [];
    calls.push([kind, ...args, stops]);
    return { addColorStop: (offset: number, color: string) => stops.push(offset, color) } as unknown as CanvasGradient;
  };
  const ctx = {
    fillStyle: "" as string | CanvasGradient,
    filter: "none",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
    imageSmoothingQuality: "low",
    fillRect: (...args: unknown[]) => calls.push(["fillRect", ctx.fillStyle, ...args]),
    createLinearGradient: (...args: unknown[]) => gradient("linear", args),
    createRadialGradient: (...args: unknown[]) => gradient("radial", args),
    drawImage: (...args: unknown[]) => calls.push(["drawImage", ...args.slice(1)]),
    save: () => calls.push(["save"]),
    restore: () => calls.push(["restore"]),
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    arcTo: () => undefined,
    closePath: () => undefined,
    clip: () => calls.push(["clip"]),
    fill: () => calls.push(["fill", ctx.shadowBlur, ctx.shadowColor]),
  };
  return { ctx, calls };
}

describe("backdrop compose", () => {
  afterEach(() => vi.restoreAllMocks());

  function compose(backdrop: Backdrop, options: Parameters<typeof composeBackdrop>[2] = {}) {
    const { ctx, calls } = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const source = document.createElement("canvas");
    source.width = 400;
    source.height = 300;
    const canvas = composeBackdrop(source, backdrop, options);
    return { canvas, calls };
  }

  it("paints the fill, the shadow plate, then the capture where the layout puts it", () => {
    const { canvas, calls } = compose({ fill: "#ffffff", padding: 20, radius: 10, shadow: true, aspect: "1:1" });
    expect([canvas.width, canvas.height]).toEqual([440, 440]);
    expect(calls[0]).toEqual(["fillRect", "#ffffff", 0, 0, 440, 440]);
    expect(calls).toContainEqual(["fill", 18, "rgba(0, 0, 0, 0.35)"]);
    expect(calls[calls.length - 2]).toEqual(["drawImage", 20, 70]);
  });

  it("casts the shadow from what has pixels only, leaving the clear parts clear", () => {
    const { canvas, calls } = compose({ fill: "transparent", padding: 20, radius: 10, shadow: true }, { clear: true });
    const shift = shadowShift(400, 18);
    // No solid plate the size of the canvas: a silhouette of the source, filled black inside its own alpha.
    expect(calls.filter((call) => call[0] === "fill")).toEqual([]);
    expect(calls).toContainEqual(["fillRect", "#000000", 0, 0, 400, 300]);
    // The silhouette is drawn out of sight, past its own shadow, then the source itself.
    expect(calls.filter((call) => call[0] === "drawImage")).toEqual([
      ["drawImage", 0, 0, 400, 300],
      ["drawImage", 20 - shift, 20],
      ["drawImage", 20, 20],
    ]);
    expect(shift).toBeGreaterThan(400 + 18 * 2);
    expect([canvas.width, canvas.height]).toEqual([440, 340]);
  });

  it("leaves a transparent backdrop unpainted", () => {
    const { calls } = compose({ fill: "transparent", padding: 20, radius: 10, shadow: false });
    expect(calls.filter((call) => call[0] === "fillRect")).toEqual([]);
    expect(calls.filter((call) => call[0] === "fill")).toEqual([]);
  });

  it("paints mesh blobs as radial gradients fading to transparent", () => {
    const { calls } = compose({ fill: "mesh-bloom", padding: 50, radius: 0, shadow: false });
    const radial = calls.filter((call) => call[0] === "radial");
    expect(radial).toHaveLength(3);
    // Centre (0, 0), from nothing out to 90% of the longer side (500px).
    expect(radial[0]).toEqual(["radial", 0, 0, 0, 0, 0, 450, [0, "#ffd36e", 1, "#ffd36e00"]]);
  });

  it("covers the output with the picked image", () => {
    const image = { width: 1000, height: 1000 } as HTMLImageElement;
    const { calls } = compose({ fill: "image", image: "/a.png", padding: 50, radius: 0, shadow: false }, { image });
    // 500×400 output: the square image's middle 1000×800.
    expect(calls).toContainEqual(["drawImage", 0, 100, 1000, 800, 0, 0, 500, 400]);
  });

  it("blurs the capture over the output", () => {
    const capture = document.createElement("canvas");
    const { calls } = compose({ fill: "blur", padding: 50, radius: 0, shadow: false }, { capture: { image: capture, area: { x: 0, y: 0, width: 400, height: 300 } } });
    const geometry = blurredGeometry({ width: 500, height: 400 });
    const { crop } = geometry;
    // The blurred canvas's middle, stretched over the whole output.
    expect(calls).toContainEqual(["drawImage", crop.x, crop.y, crop.width, crop.height, 0, 0, 500, 400]);
  });

  it("draws the painted layers in order", () => {
    const { ctx, calls } = recordingContext();
    paintBackdrop(ctx as unknown as CanvasRenderingContext2D, [
      { kind: "solid", color: "#111111" },
      { kind: "linear", start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, stops: [0, "#000000", 1, "#ffffff"] },
    ], { width: 10, height: 5 }, {});
    expect(calls.map((call) => call[0])).toEqual(["fillRect", "linear", "fillRect"]);
    expect(calls[1]).toEqual(["linear", 0, 0, 10, 0, [0, "#000000", 1, "#ffffff"]]);
  });
});

/** Mounts an annotation on a real Konva layer with a recording 2D context. */
function drawnShape(shape: Shape) {
  const noop = () => undefined;
  const calls: unknown[][] = [];
  const drawing = new Set(["moveTo", "lineTo", "quadraticCurveTo", "closePath", "arc", "ellipse", "fill", "stroke"]);
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === "getImageData") return () => ({ data: new Uint8ClampedArray(400).fill(255) });
      if (key === "measureText") return () => ({ width: 10 });
      if (typeof key === "string" && drawing.has(key)) {
        return (...args: unknown[]) => {
          calls.push(key === "fill" || key === "stroke" ? [key, target[`${key}Style`]] : [key, ...args]);
        };
      }
      return noop;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  let layer: Konva.Layer | null = null;
  flushSync(() =>
    root.render(
      createElement(
        Stage,
        { width: 400, height: 300 },
        createElement(
          Layer,
          { ref: (node: Konva.Layer | null) => { layer = node; } },
          createElement(ShapeNode, { shape, image: null, editable: false, onSelect: noop, onChange: noop, onEditText: noop }),
        ),
      ),
    ),
  );
  const drawn = layer as Konva.Layer | null;
  return { layer: drawn, node: drawn?.findOne(`#${shape.id}`), calls, cleanup: () => { root.unmount(); host.remove(); } };
}

describe("arrows in exports", () => {
  afterEach(() => vi.restoreAllMocks());

  const arrow: LineShape = { id: "a", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [20, 60, 220, 110] };

  function drawArrow(shape: LineShape) {
    const { layer, calls, cleanup } = drawnShape(shape);
    try {
      if (!layer) throw new Error("Konva export layer did not mount");
      calls.length = 0;
      layer.toCanvas({ x: 0, y: 0, width: 400, height: 300, pixelRatio: 1 });
      return calls.slice();
    } finally {
      cleanup();
    }
  }

  it("paints twelve distinct arrow presets on the layer Copy and Export flatten", () => {
    const drawings = ARROW_STYLES.map(({ id: arrowStyle }) => drawArrow({ ...arrow, arrowStyle }));
    expect(new Set(drawings.map((calls) => JSON.stringify(calls))).size).toBe(12);
    drawings.forEach((calls, index) => {
      const { id } = ARROW_STYLES[index];
      const paint = calls.filter(([op]) => op === "fill" || op === "stroke");
      expect(paint.length, id).toBeGreaterThan(0);
      expect(paint.every(([, color]) => color === arrow.color), id).toBe(true);
      expect(calls).toContainEqual(["lineTo", 220, 110]);
      if (id === "outline") expect(paint).toEqual([["stroke", arrow.color]]);
    });
  });

  it("paints the curve through the tip with its filled head pointing along the end tangent", () => {
    const calls = drawArrow({ ...arrow, control: [220, 50] });
    expect(calls).toContainEqual(["quadraticCurveTo", 220, 50, 220, 110]);
    // This curve ends pointing straight down, with the horizontal head base above it.
    expect(calls).toContainEqual(["moveTo", 211, 92]);
    expect(calls).toContainEqual(["lineTo", 229, 92]);
    expect(calls).toContainEqual(["fill", arrow.color]);
  });
});

describe("oriented and resized export", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Flattens a fake layer; returns what it was asked to render and the size encoded. */
  async function run(doc: Parameters<typeof flatten>[1], format: "png" | "jpg" = "png", options: Parameters<typeof flatten>[5] = {}) {
    const { ctx, calls } = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const encoded: { width: number; height: number; mime: string }[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback, mime) {
      encoded.push({ width: this.width, height: this.height, mime: mime ?? "" });
      callback(new Blob([new Uint8Array([7])]));
    });
    const areas: unknown[] = [];
    const layer = {
      toCanvas: (area: { width: number; height: number; pixelRatio: number }) => {
        areas.push(area);
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(area.width * area.pixelRatio);
        canvas.height = Math.round(area.height * area.pixelRatio);
        return canvas;
      },
    };
    await flatten(layer as never, doc, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, format, options);
    return { areas, encoded, calls };
  }

  it("renders the turned capture and keeps old documents as they were", async () => {
    expect((await run({ crop: null })).encoded).toEqual([{ width: 400, height: 300, mime: "image/png" }]);
    const turned = await run({ crop: { x: 0, y: 0, width: 100, height: 50 }, rotation: 90, flipY: true });
    expect(turned.areas).toEqual([{ x: 250, y: 300, width: 50, height: 100, pixelRatio: 1 }]);
    expect(turned.encoded[0]).toMatchObject({ width: 50, height: 100 });
  });

  it("resizes the whole output, backdrop included, before JPEG goes on white", async () => {
    const { encoded, calls } = await run(
      { crop: null, rotation: 270, scale: 0.5, backdrop: { fill: "#ffffff", padding: 50, radius: 0, shadow: false } },
      "jpg",
    );
    // 300×400 turned, 400×500 framed, halved.
    expect(encoded).toEqual([{ width: 200, height: 250, mime: "image/jpeg" }]);
    expect(calls).toContainEqual(["drawImage", 0, 0, 200, 250]);
  });

  it("renders the whole grown canvas, images included", async () => {
    const grown = await run({ crop: { x: 0, y: 0, width: 800, height: 300 } });
    expect(grown.areas).toEqual([{ x: 0, y: 0, width: 800, height: 300, pixelRatio: 1 }]);
    expect(grown.encoded).toEqual([{ width: 800, height: 300, mime: "image/png" }]);
  });

  it("renders a grown canvas without a crop, and frames it whole", async () => {
    const canvas = { x: 0, y: 0, width: 800, height: 300 };
    const plain = await run({ crop: null }, "png", { canvas });
    expect(plain.areas).toEqual([{ x: 0, y: 0, width: 800, height: 300, pixelRatio: 1 }]);
    expect(plain.encoded).toEqual([{ width: 800, height: 300, mime: "image/png" }]);
    const framed = await run({ crop: null, backdrop: { fill: "#ffffff", padding: 20, radius: 0, shadow: true } }, "png", { canvas });
    expect(framed.encoded).toEqual([{ width: 840, height: 340, mime: "image/png" }]);
    // The shadow follows the content's silhouette, not a solid plate over the clear parts.
    expect(framed.calls).toContainEqual(["drawImage", 20 - shadowShift(800, 18), 20]);
    expect(framed.calls.filter((call) => call[0] === "fill")).toEqual([]);
  });

  it("enlarges by a percentage", async () => {
    expect((await run({ crop: null, scale: 1.5 })).encoded[0]).toMatchObject({ width: 600, height: 450 });
  });

  it("leaves the output alone at 100%", () => {
    const source = document.createElement("canvas");
    expect(resample(source, 1)).toBe(source);
  });

  it("halves step by step when shrinking a lot", () => {
    const { ctx, calls } = recordingContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    const source = document.createElement("canvas");
    source.width = 1000;
    source.height = 800;
    const out = resample(source, 0.1);
    expect([out.width, out.height]).toEqual([100, 80]);
    expect(calls.filter((call) => call[0] === "drawImage").map((call) => call.slice(3))).toEqual([
      [500, 400],
      [250, 200],
      [125, 100],
      [100, 80],
    ]);
  });
});

type RGBA = [number, number, number, number];

/** A `width`×`height` image of `background`, with each of `boxes` painted over it. */
function pixels(width: number, height: number, background: RGBA, boxes: { x: number; y: number; width: number; height: number; color: RGBA }[] = []): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(background, i * 4);
  for (const box of boxes) {
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) data.set(box.color, (y * width + x) * 4);
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

describe("plain borders", () => {
  it("counts the plain rows and columns on each side", () => {
    const image = pixels(10, 8, WHITE, [{ x: 2, y: 1, width: 3, height: 5, color: BLACK }]);
    expect(plainBorders(image)).toEqual({ top: 1, right: 5, bottom: 2, left: 2 });
  });

  it("counts a pixel within the tolerance as plain, and one past it as content", () => {
    const near = pixels(10, 8, WHITE, [
      { x: 2, y: 1, width: 3, height: 5, color: BLACK },
      { x: 8, y: 3, width: 1, height: 1, color: [250, 250, 250, 255] },
    ]);
    expect(plainBorders(near).right).toBe(5);
    const far = pixels(10, 8, WHITE, [
      { x: 2, y: 1, width: 3, height: 5, color: BLACK },
      { x: 8, y: 3, width: 1, height: 1, color: [230, 255, 255, 255] },
    ]);
    expect(plainBorders(far).right).toBe(1);
  });

  it("measures each edge against its own colour", () => {
    // A grey band down the left, white elsewhere.
    const image = pixels(10, 8, WHITE, [
      { x: 0, y: 0, width: 3, height: 8, color: [128, 128, 128, 255] },
      { x: 4, y: 2, width: 2, height: 2, color: BLACK },
    ]);
    expect(plainBorders(image)).toEqual({ top: 0, right: 4, bottom: 0, left: 3 });
  });

  it("measures the side margins only between the top and bottom borders", () => {
    // A red title bar across the top would otherwise stop the left margin at column 0.
    const image = pixels(10, 8, WHITE, [
      { x: 0, y: 0, width: 10, height: 2, color: [229, 72, 77, 255] },
      { x: 6, y: 4, width: 2, height: 2, color: BLACK },
    ]);
    expect(plainBorders(image)).toEqual({ top: 2, right: 2, bottom: 2, left: 6 });
  });

  it("measures a capture that is plain all over, or empty, as no border", () => {
    expect(plainBorders(pixels(10, 8, WHITE))).toEqual(NO_BORDERS);
    expect(plainBorders(pixels(0, 0, WHITE))).toEqual(NO_BORDERS);
  });
});

describe("balanced backdrop", () => {
  const backdrop: Backdrop = { fill: "ocean", padding: 64, radius: 12, shadow: true, balance: true };
  const size = { width: 400, height: 300 };

  it("shifts the capture so its content is centred, keeping the output size", () => {
    // 80px of empty margin on the right: the left gets 40 more padding, the right 40 less.
    const layout = backdropLayout(size, backdrop, 1, { top: 0, right: 80, bottom: 0, left: 0 });
    expect(layout).toMatchObject({ width: 528, height: 428, x: 104, y: 64 });
    // Plain border plus padding match: 104 on the left, 24 + 80 on the right.
    expect(layout.width - layout.x - size.width + 80).toBe(layout.x);
    expect(backdropLayout(size, backdrop, 1, { top: 40, right: 0, bottom: 0, left: 60 })).toMatchObject({ width: 528, height: 428, x: 34, y: 44 });
  });

  it("grows the output only when the padding cannot absorb the difference", () => {
    expect(backdropLayout(size, { ...backdrop, padding: 20 }, 1, { top: 0, right: 100, bottom: 0, left: 0 })).toMatchObject({
      width: 500,
      height: 340,
      x: 100,
      y: 20,
    });
    expect(backdropLayout(size, { ...backdrop, padding: 0 }, 1, { top: 30, right: 0, bottom: 0, left: 0 })).toMatchObject({
      width: 400,
      height: 330,
      x: 0,
      y: 0,
    });
  });

  it("reaches the aspect ratio after balancing, keeping the balance", () => {
    // As the even 16:9 layout (x 181), shifted by the same 40px.
    expect(backdropLayout(size, { ...backdrop, aspect: "16:9" }, 1, { top: 0, right: 80, bottom: 0, left: 0 })).toMatchObject({
      width: 761,
      height: 428,
      x: 221,
      y: 64,
    });
  });

  it("pads evenly for a uniform capture, with balance off, or before the borders are measured", () => {
    const even = { width: 528, height: 428, x: 64, y: 64 };
    expect(backdropLayout(size, backdrop, 1, plainBorders(pixels(40, 30, WHITE)))).toMatchObject(even);
    expect(backdropLayout(size, { ...backdrop, balance: false }, 1, { top: 0, right: 80, bottom: 0, left: 0 })).toMatchObject(even);
    expect(backdropLayout(size, { ...backdrop, balance: undefined }, 1, { top: 0, right: 80, bottom: 0, left: 0 })).toMatchObject(even);
    expect(backdropLayout(size, backdrop, 1, null)).toMatchObject(even);
    expect(backdropLayout(size, backdrop)).toMatchObject(even);
  });
});


describe("magnify lenses in exports", () => {
  const lens: MagnifyShape = { id: "m", type: "magnify", x: 200, y: 100, width: 120, height: 120,
    color: "#0090ff", strokeWidth: 4, spot: [60, 70], zoom: 3 };
  function draw(shape: MagnifyShape) {
    const calls: unknown[][] = [];
    const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
    const ctx = Object.fromEntries(["beginPath", "arc", "moveTo", "lineTo", "arcTo", "closePath", "save", "restore", "clip", "drawImage", "fillShape", "strokeShape"]
      .map((name) => [name, record(name)]));
    const image = {} as HTMLImageElement;
    const node = {} as Konva.Shape;
    magnifyScene(shape, image)(ctx as unknown as Konva.Context, node);
    return { calls, image, node };
  }
  it("clips a round lens before sampling the zoomed original capture, then strokes its border", () => {
    const { calls, image, node } = draw(lens);
    expect(calls).toContainEqual(["arc", 60, 60, 60, 0, Math.PI * 2]);
    expect(calls).toContainEqual(["drawImage", image, 40, 50, 40, 40, 0, 0, 120, 120]);
    const order = calls.map(([name]) => name);
    expect(order.indexOf("clip")).toBeLessThan(order.indexOf("drawImage"));
    expect(order.indexOf("restore")).toBeLessThan(order.indexOf("strokeShape"));
    expect(calls[calls.length - 1]).toEqual(["strokeShape", node]);
  });
  it("clips the rounded square outline, and samples a smaller source at 6x", () => {
    const { calls, image } = draw({ ...lens, lens: "square", zoom: 6 });
    expect(calls.filter(([name]) => name === "arcTo")).toHaveLength(4);
    expect(calls.some(([name]) => name === "arc")).toBe(false);
    expect(calls).toContainEqual(["drawImage", image, 50, 60, 20, 20, 0, 0, 120, 120]);
    expect(calls.filter(([name]) => name === "clip")).toHaveLength(1);
  });
  it("ends the line at the round or rounded square edge, omitting it for an interior spot", () => {
    const atLeft = { ...lens, spot: [0, 160] as [number, number] };
    for (const value of [atLeft, { ...atLeft, lens: "square" as const }]) {
      const points = magnifyLinePoints(value);
      expect(points.slice(0, 2)).toEqual([0, 160]);
      expect(points[2]).toBeCloseTo(200);
      expect(points[3]).toBeCloseTo(160);
    }
    expect(magnifyLinePoints({ ...lens, spot: [260, 160] })).toEqual([]);
  });
});

/**
 * Stamps are drawn on the same layer copy and export flatten, turned about
 * their centre: what is exported is what shows.
 */
describe("rotated stamps in exports", () => {
  afterEach(() => vi.restoreAllMocks());

  it("turns a stamp about its centre, keeping its size", () => {
    const stamp: StampShape = { id: "k", type: "stamp", name: "check", x: 100, y: 80, size: 48, rotation: 45, color: "#30a46c" };
    const { node, cleanup } = drawnShape(stamp);
    try {
      expect(node?.rotation()).toBe(45);
      expect(node?.position()).toEqual({ x: 100, y: 80 });
      // The 48px square turned 45° covers 48√2 each way, still centred on 100, 80.
      const box = node!.getClientRect({ skipStroke: true });
      expect(box.width).toBeCloseTo(48 * Math.SQRT2, 1);
      expect(box.height).toBeCloseTo(48 * Math.SQRT2, 1);
      expect(box.x + box.width / 2).toBeCloseTo(100, 1);
      expect(box.y + box.height / 2).toBeCloseTo(80, 1);
    } finally {
      cleanup();
    }
  });

  it("draws an upright stamp's box at its size", () => {
    const { node, cleanup } = drawnShape({ id: "u", type: "stamp", name: "cursor-arrow", x: 50, y: 50, size: 64 });
    try {
      expect(node?.rotation()).toBe(0);
      const box = node!.getClientRect({ skipStroke: true });
      expect(box.height).toBeCloseTo(64, 1);
      expect(box.width).toBeCloseTo(44, 1);
    } finally {
      cleanup();
    }
  });
});
