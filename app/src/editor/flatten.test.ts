import Konva from "konva";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  angleLine,
  backdropLayout,
  backdropPaint,
  blurredGeometry,
  BLURRED_SIZE,
  composeBackdrop,
  coverCrop,
  exportArea,
  exportTarget,
  flatten,
  gradientStops,
  NO_BORDERS,
  paintBackdrop,
  plainBorders,
  resample,
  type PaintLayer,
} from "./flatten";
import { backdropColors, sameBackdrop, type Backdrop, type LineShape } from "./model";
import { curvePoints } from "./tools";

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

  it("picks PNG or JPG from the file name", () => {
    expect(exportTarget("/tmp/a.JPG")).toEqual({ path: "/tmp/a.JPG", format: "jpg" });
    expect(exportTarget("/tmp/a.jpeg")).toEqual({ path: "/tmp/a.jpeg", format: "jpg" });
    expect(exportTarget("/tmp/a.png")).toEqual({ path: "/tmp/a.png", format: "png" });
    expect(exportTarget("/tmp/a")).toEqual({ path: "/tmp/a.png", format: "png" });
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

/**
 * Exports render the content layer as ShapeNode draws it, so a curved arrow
 * exports as Konva draws it from `curvePoints`: one bezier segment, its head
 * turned along the curve's end rather than from start to end.
 */
describe("curved arrows in exports", () => {
  function drawArrow(shape: LineShape) {
    const calls: unknown[][] = [];
    const record = (name: string) => (...args: unknown[]) => calls.push([name, ...args]);
    const ctx = {
      beginPath: record("beginPath"),
      moveTo: record("moveTo"),
      lineTo: record("lineTo"),
      bezierCurveTo: record("bezierCurveTo"),
      closePath: record("closePath"),
      save: record("save"),
      restore: record("restore"),
      translate: record("translate"),
      rotate: record("rotate"),
      setLineDash: record("setLineDash"),
      strokeShape: record("strokeShape"),
      fillStrokeShape: record("fillStrokeShape"),
    };
    // jsdom has no 2D canvas; Konva probes one for its hit colours when a shape is made.
    const probe = {
      clearRect: () => undefined,
      fillRect: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(400).map((_, i) => (i % 4 === 3 ? 255 : 40)) }),
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(probe as unknown as CanvasRenderingContext2D);
    const arrow = new Konva.Arrow({
      points: curvePoints(shape),
      bezier: Boolean(shape.control),
      stroke: shape.color,
      fill: shape.color,
      strokeWidth: shape.strokeWidth,
      pointerLength: 10,
      pointerWidth: 10,
    });
    (arrow as unknown as { _sceneFunc: (context: unknown) => void })._sceneFunc(ctx);
    return calls;
  }

  const arrow: LineShape = { id: "a", type: "arrow", color: "#e5484d", strokeWidth: 4, points: [0, 0, 100, 0] };

  it("draws a curved arrow as one bezier with its head along the end tangent", () => {
    const calls = drawArrow({ ...arrow, control: [50, -60] });
    const curves = calls.filter((call) => call[0] === "bezierCurveTo");
    expect(curves).toHaveLength(1);
    expect(curves[0].slice(5)).toEqual([100, 0]);
    expect(calls).toContainEqual(["translate", 100, 0]);
    const angle = calls.find((call) => call[0] === "rotate")?.[1] as number;
    // The quadratic's end tangent runs from the control (50, -60) to the end (100, 0).
    const tangent = (Math.atan2(60, 50) + Math.PI * 2) % (Math.PI * 2);
    expect(angle).toBeCloseTo(tangent);
    expect(angle).not.toBeCloseTo(0);
  });

  it("draws a straight arrow as before", () => {
    const calls = drawArrow(arrow);
    expect(calls.filter((call) => call[0] === "bezierCurveTo")).toEqual([]);
    expect(calls).toContainEqual(["lineTo", 100, 0]);
    expect(calls.find((call) => call[0] === "rotate")?.[1]).toBeCloseTo(0);
  });
});

describe("oriented and resized export", () => {
  afterEach(() => vi.restoreAllMocks());

  /** Flattens a fake layer; returns what it was asked to render and the size encoded. */
  async function run(doc: Parameters<typeof flatten>[1], format: "png" | "jpg" = "png") {
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
    await flatten(layer as never, doc, { width: 400, height: 300 }, { scale: 1, x: 0, y: 0 }, format);
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
