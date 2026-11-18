import { describe, expect, it } from "vitest";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_STEP_RADIUS,
  emptyAnnotations,
  FONT_SIZES,
  nearestPreset,
  STEP_RADII,
  STROKE_WIDTHS,
  widthFor,
  widthKind,
  canvasBounds,
  type ImageShape,
  type LineShape,
  type Shape,
  type Style,
} from "./model";
import {
  addShape,
  ALL_ANCHORS,
  ALL_SIDES,
  anchorSides,
  anchorsFor,
  CORNER_ANCHORS,
  beginShape,
  bendLine,
  colorForKey,
  contrastColor,
  controlFromHandle,
  cropAspectRatio,
  cropBox,
  cropDragRatio,
  cropFromDrag,
  cropToCapture,
  curveMidpoint,
  curvePoints,
  deleteShape,
  dragShape,
  duplicateShape,
  finishShape,
  fitCropToRatio,
  hasLineHandles,
  HIGHLIGHTER_WIDTH,
  highlighterWidth,
  imageAt,
  imageBeside,
  keepsRatio,
  reorderShape,
  holdCropSides,
  HOLD_MS,
  modifierTool,
  moveCrop,
  moveLineEnd,
  moveShape,
  nearestLine,
  nudgeDelta,
  releaseRestores,
  replaceShape,
  resizeCrop,
  restyleShape,
  simplifyPath,
  smoothPath,
  snapAngle,
  snapCropDrag,
  snapCropEdges,
  spotlightDim,
  squareCorner,
  stepNumbers,
  stepStrokeWidth,
  textLook,
  textLookStyle,
  textShadowColor,
  tidyPath,
  transformShape,
  withAlpha,
  withCaptureBorders,
} from "./tools";
import { IDENTITY, orientRect } from "./orient";

const style: Style = { color: "#e5484d", strokeWidth: 4 };

/** Draws with `tool` from `from` through `path`, as the editor does. */
function draw(tool: Parameters<typeof beginShape>[0], from: [number, number], ...path: [number, number][]) {
  let shape = beginShape(tool, { x: from[0], y: from[1] }, style, "id");
  if (!shape) return null;
  for (const [x, y] of path) shape = dragShape(shape, { x, y });
  return finishShape(shape);
}

/** Like `draw`, holding Shift for every move. */
function drawConstrained(tool: Parameters<typeof beginShape>[0], from: [number, number], to: [number, number]) {
  const shape = beginShape(tool, { x: from[0], y: from[1] }, style, "id");
  return shape && finishShape(dragShape(shape, { x: to[0], y: to[1] }, true));
}

describe("tidying paths", () => {
  it("smooths every point but the ends", () => {
    expect(smoothPath([0, 0, 10, 8, 20, 0], 1)).toEqual([0, 0, 10, 4, 20, 0]);
    expect(smoothPath([0, 0, 10, 8], 3)).toEqual([0, 0, 10, 8]);
  });

  it("drops points within the tolerance and keeps those beyond it", () => {
    expect(simplifyPath([0, 0, 5, 0.5, 10, 0], 1)).toEqual([0, 0, 10, 0]);
    expect(simplifyPath([0, 0, 5, 3, 10, 0], 1)).toEqual([0, 0, 5, 3, 10, 0]);
    expect(simplifyPath([0, 0, 1, 1], 1)).toEqual([0, 0, 1, 1]);
  });

  it("keeps a loop that ends where it started", () => {
    expect(simplifyPath([0, 0, 10, 0, 10, 10, 0, 10, 0, 0], 1)).toEqual([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]);
  });

  it("lets a thicker stroke stray further", () => {
    const points = [0, 0, 10, 8, 20, 0];
    expect(tidyPath(points, 4).length).toBe(6);
    expect(tidyPath(points, 24)).toEqual([0, 0, 20, 0]);
  });
});

describe("constraining with Shift", () => {
  it.each([
    [{ x: 100, y: 10 }, { x: 100, y: 0 }],
    [{ x: -10, y: 80 }, { x: 0, y: 80 }],
    [{ x: 100, y: 90 }, { x: 95, y: 95 }],
    [{ x: -60, y: -40 }, { x: -50, y: -50 }],
  ])("snaps a line towards %o to %o", (to, expected) => {
    expect(snapAngle({ x: 0, y: 0 }, to)).toEqual(expected);
  });

  it("snaps from the line's start, not the origin", () => {
    expect(snapAngle({ x: 50, y: 50 }, { x: 150, y: 58 })).toEqual({ x: 150, y: 50 });
  });

  it.each([
    [{ x: 80, y: 30 }, { x: 80, y: 80 }],
    [{ x: -20, y: 50 }, { x: -50, y: 50 }],
    [{ x: -40, y: -10 }, { x: -40, y: -40 }],
  ])("squares a box dragged to %o at %o", (to, expected) => {
    expect(squareCorner({ x: 0, y: 0 }, to)).toEqual(expected);
  });

  it.each(["arrow", "line"] as const)("keeps a %s to 45° steps", (tool) => {
    expect(drawConstrained(tool, [10, 10], [110, 15])).toMatchObject({ points: [10, 10, 110, 10] });
  });

  it.each(["rect", "ellipse", "blur", "spotlight"] as const)("makes a %s square", (tool) => {
    expect(drawConstrained(tool, [100, 100], [40, 70])).toMatchObject({ x: 40, y: 40, width: 60, height: 60 });
  });

  it("leaves freehand paths free", () => {
    expect(drawConstrained("freehand", [0, 0], [30, 7])).toMatchObject({ points: [0, 0, 30, 7] });
  });

  it("draws freely without Shift", () => {
    expect(draw("rect", [0, 0], [80, 30])).toMatchObject({ width: 80, height: 30 });
  });
});

describe("quick tool shortcuts", () => {
  it("treats a quick tap as a switch and a long press or a drag as a hold", () => {
    expect(releaseRestores(HOLD_MS - 1, false)).toBe(false);
    expect(releaseRestores(HOLD_MS, false)).toBe(true);
    expect(releaseRestores(20, true)).toBe(true);
  });

  it("draws a rectangle on ⌘ or Ctrl and an arrow on ⌥ or Alt", () => {
    expect(modifierTool({ ctrlKey: false, metaKey: true, altKey: false })).toBe("rect");
    expect(modifierTool({ ctrlKey: true, metaKey: false, altKey: false })).toBe("rect");
    expect(modifierTool({ ctrlKey: false, metaKey: false, altKey: true })).toBe("arrow");
    expect(modifierTool({ ctrlKey: true, metaKey: false, altKey: true })).toBe("rect");
    expect(modifierTool({ ctrlKey: false, metaKey: false, altKey: false })).toBeNull();
  });

  it("keeps ⌥ for unsnapped crops with the Crop tool, and ⌘ still draws a rectangle", () => {
    expect(modifierTool({ ctrlKey: false, metaKey: false, altKey: true }, "crop")).toBeNull();
    expect(modifierTool({ ctrlKey: true, metaKey: false, altKey: false }, "crop")).toBe("rect");
    expect(modifierTool({ ctrlKey: false, metaKey: true, altKey: true }, "crop")).toBe("rect");
    expect(modifierTool({ ctrlKey: false, metaKey: false, altKey: true }, "select")).toBe("arrow");
  });

  it("keeps ⌥ for unsnapped strips with the Cut out tool, and ⌘ still draws a rectangle", () => {
    expect(modifierTool({ ctrlKey: false, metaKey: false, altKey: true }, "cut")).toBeNull();
    expect(modifierTool({ ctrlKey: true, metaKey: false, altKey: false }, "cut")).toBe("rect");
    expect(modifierTool({ ctrlKey: false, metaKey: true, altKey: true }, "cut")).toBe("rect");
  });

  it("maps 1–7 to the swatches and ignores other keys", () => {
    expect(colorForKey("1")).toBe("#e5484d");
    expect(colorForKey("7")).toBe("#ffffff");
    expect(colorForKey("8")).toBeNull();
    expect(colorForKey("0")).toBeNull();
    expect(colorForKey("a")).toBeNull();
    expect(colorForKey("!")).toBeNull();
  });
});

describe("drawing tools", () => {
  it.each(["arrow", "line"] as const)("draws a %s between two points", (tool) => {
    expect(draw(tool, [10, 20], [50, 60], [110, 120])).toEqual({
      id: "id",
      type: tool,
      color: "#e5484d",
      strokeWidth: 4,
      points: [10, 20, 110, 120],
    });
  });

  it.each(["rect", "ellipse", "blur", "spotlight"] as const)("normalises a %s dragged up and left", (tool) => {
    const shape = draw(tool, [100, 80], [40, 30]);
    expect(shape).toMatchObject({ type: tool, x: 40, y: 30, width: 60, height: 50 });
  });

  it("keeps colour and width on stroked shapes", () => {
    expect(draw("rect", [0, 0], [10, 10])).toMatchObject({ color: "#e5484d", strokeWidth: 4 });
  });

  it("gives blur a pixel size and no colour", () => {
    const blur = draw("blur", [0, 0], [40, 40]);
    expect(blur).toMatchObject({ type: "blur", pixelSize: expect.any(Number) });
    expect(blur).not.toHaveProperty("color");
  });

  it("gives a spotlight only its area", () => {
    expect(draw("spotlight", [10, 10], [60, 40])).toEqual({ id: "id", type: "spotlight", x: 10, y: 10, width: 50, height: 30 });
    expect(draw("spotlight", [10, 10], [11, 11])).toBeNull();
  });

  it("writes fill and blur mode only when they are on", () => {
    expect(draw("rect", [0, 0], [10, 10])).not.toHaveProperty("fill");
    expect(draw("blur", [0, 0], [10, 10])).not.toHaveProperty("mode");
    const at = { x: 0, y: 0 };
    expect(beginShape("ellipse", at, { ...style, fill: true }, "e")).toMatchObject({ fill: true });
    expect(beginShape("blur", at, { ...style, blurMode: "blur" }, "b")).toMatchObject({ mode: "blur" });
    expect(beginShape("blur", at, { ...style, blurMode: "pixelate" }, "b")).not.toHaveProperty("mode");
  });

  it("records a freehand path as it is drawn, then smooths it when it ends", () => {
    let shape = beginShape("freehand", { x: 0, y: 0 }, style, "id")!;
    for (const [x, y] of [[5, 5], [10, 0]]) shape = dragShape(shape, { x, y });
    expect(shape).toMatchObject({ points: [0, 0, 5, 5, 10, 0] });
    expect(finishShape(shape)).toMatchObject({ points: [0, 0, 5, 1.25, 10, 0] });
  });

  it("evens out a shaky freehand stroke and drops the points it does not need", () => {
    // A straight stroke along y = 10, wobbling a pixel either way every 2 pixels.
    const path: [number, number][] = [];
    for (let x = 2; x <= 100; x += 2) path.push([x, x % 4 === 0 ? 11 : 9]);
    path.push([102, 10]);
    const shape = draw("freehand", [0, 10], ...path) as { points: number[] };
    expect(shape.points.slice(0, 2)).toEqual([0, 10]);
    expect(shape.points.slice(-2)).toEqual([102, 10]);
    expect(shape.points.length).toBeLessThan(10);
    for (let i = 1; i < shape.points.length; i += 2) expect(Math.abs(shape.points[i] - 10)).toBeLessThanOrEqual(1);
  });

  it("keeps the corners of a freehand path", () => {
    const shape = draw("freehand", [0, 0], [25, 0], [50, 0], [50, 25], [50, 50]) as { points: number[] };
    expect(shape.points.slice(0, 2)).toEqual([0, 0]);
    expect(shape.points.slice(-2)).toEqual([50, 50]);
    // The corner is rounded a little, but still there.
    expect(shape.points.length).toBeGreaterThan(4);
  });

  it("smooths and simplifies the highlighter too", () => {
    const shape = draw("highlighter", [0, 0], [10, 1], [20, -1], [30, 1], [40, 0]) as { points: number[] };
    expect(shape.points).toEqual([0, 0, 40, 0]);
  });

  it("draws the highlighter wide", () => {
    const shape = draw("highlighter", [0, 0], [50, 0]);
    expect(shape).toMatchObject({ type: "highlighter", points: [0, 0, 50, 0] });
    expect((shape as { strokeWidth: number }).strokeWidth).toBeGreaterThanOrEqual(HIGHLIGHTER_WIDTH);
  });

  it("turns a freehand click into a dot", () => {
    expect((draw("freehand", [5, 5]) as { points: number[] }).points).toHaveLength(4);
  });

  it("drops shapes too small to see", () => {
    expect(draw("rect", [10, 10], [11, 40])).toBeNull();
    expect(draw("arrow", [10, 10], [11, 11])).toBeNull();
  });

  it("places a step badge on click", () => {
    expect(beginShape("step", { x: 30, y: 40 }, style, "s")).toMatchObject({ type: "step", x: 30, y: 40, color: "#e5484d" });
  });

  it("leaves text, crop, select and pan to the editor", () => {
    for (const tool of ["text", "crop", "select", "pan"] as const) {
      expect(beginShape(tool, { x: 0, y: 0 }, style)).toBeNull();
    }
  });
});

describe("step badges", () => {
  it("number steps in the order they were added, skipping other shapes", () => {
    const shapes: Shape[] = [
      { id: "a", type: "step", color: "red", x: 0, y: 0, radius: 10 },
      { id: "r", type: "rect", color: "red", strokeWidth: 2, x: 0, y: 0, width: 5, height: 5 },
      { id: "b", type: "step", color: "red", x: 0, y: 0, radius: 10 },
      { id: "c", type: "step", color: "red", x: 0, y: 0, radius: 10 },
    ];
    expect([...stepNumbers(shapes)]).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    // Deleting a step renumbers the rest.
    expect([...stepNumbers(shapes.filter((shape) => shape.id !== "a"))]).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("show a step's own number when it has one", () => {
    const shapes: Shape[] = [
      { id: "g", type: "step", color: "red", x: 0, y: 0, radius: 10, number: 4 },
      { id: "a", type: "step", color: "red", x: 0, y: 0, radius: 10 },
    ];
    expect([...stepNumbers(shapes)]).toEqual([
      ["g", 4],
      ["a", 1],
    ]);
  });
});

describe("crop", () => {
  it("clips the crop to the image and rounds to pixels", () => {
    expect(cropFromDrag({ x: 90.4, y: -10 }, { x: -5, y: 50.6 }, { width: 80, height: 60 })).toEqual({
      x: 0,
      y: 0,
      width: 80,
      height: 51,
    });
  });

  it("ignores a stray click", () => {
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 11, y: 11 }, { width: 80, height: 60 })).toBeNull();
  });
});

describe("crop ratios", () => {
  const image = { width: 400, height: 300 };

  it("reads each aspect's ratio, Original from the capture", () => {
    expect(cropAspectRatio("free", image)).toBeNull();
    expect(cropAspectRatio("original", image)).toBeCloseTo(4 / 3);
    expect(cropAspectRatio("original", { width: 100, height: 400 })).toBe(0.25);
    expect(cropAspectRatio("original", null)).toBeNull();
    expect(cropAspectRatio("16:9", image)).toBe(16 / 9);
    expect(cropAspectRatio("9:16", image)).toBe(9 / 16);
    expect(cropAspectRatio("1:1", image)).toBe(1);
  });

  it("squares a Free crop with Shift, and leaves a picked ratio alone", () => {
    expect(cropDragRatio(null, false)).toBeNull();
    expect(cropDragRatio(null, true)).toBe(1);
    expect(cropDragRatio(16 / 9, true)).toBe(16 / 9);
    expect(cropDragRatio(16 / 9, false)).toBe(16 / 9);
    // A Shift-squared drag: the longer side wins.
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 60, y: 110 }, image, cropDragRatio(null, true))).toEqual({ x: 10, y: 10, width: 100, height: 100 });
  });

  it("holds a drag to the ratio from the start corner", () => {
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 110, y: 60 }, image, 2)).toEqual({ x: 10, y: 10, width: 100, height: 50 });
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 30, y: 110 }, image, 2)).toEqual({ x: 10, y: 10, width: 200, height: 100 });
    expect(cropFromDrag({ x: 100, y: 100 }, { x: 0, y: 90 }, image, 1)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(cropFromDrag({ x: 0, y: 0 }, { x: 160, y: 0 }, image, 16 / 9)).toEqual({ x: 0, y: 0, width: 160, height: 90 });
  });

  it("shrinks a ratio drag to fit inside the image", () => {
    // Heading right: only 100px are left before the edge.
    expect(cropFromDrag({ x: 300, y: 200 }, { x: 420, y: 210 }, image, 2)).toEqual({ x: 300, y: 200, width: 100, height: 50 });
    // Heading up and left: the top edge is nearer.
    expect(cropFromDrag({ x: 50, y: 40 }, { x: 0, y: 0 }, image, 2)).toEqual({ x: 0, y: 15, width: 50, height: 25 });
    // A start outside the image begins at its edge.
    expect(cropFromDrag({ x: -20, y: -20 }, { x: 100, y: 50 }, image, 1)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    // Every ratio box stays inside.
    for (const ratio of [16 / 9, 4 / 3, 1, 9 / 16]) {
      const crop = cropFromDrag({ x: 390, y: 290 }, { x: -500, y: -500 }, image, ratio);
      expect(crop).not.toBeNull();
      expect(crop!.x).toBeGreaterThanOrEqual(0);
      expect(crop!.y).toBeGreaterThanOrEqual(0);
      expect(crop!.x + crop!.width).toBeLessThanOrEqual(390);
      expect(crop!.y + crop!.height).toBeLessThanOrEqual(290);
    }
  });

  it("previews a drag that is still too small", () => {
    expect(cropBox({ x: 10, y: 10 }, { x: 11, y: 11 }, image, 1)).toEqual({ x: 10, y: 10, width: 1, height: 1 });
    expect(cropBox({ x: 10, y: 10 }, { x: 10, y: 10 }, image)).toEqual({ x: 10, y: 10, width: 0, height: 0 });
    expect(cropFromDrag({ x: 10, y: 10 }, { x: 11, y: 11 }, image, 1)).toBeNull();
  });

  it("fits the largest centred box of a ratio inside a crop", () => {
    expect(fitCropToRatio({ x: 0, y: 0, width: 320, height: 240 }, 16 / 9)).toEqual({ x: 0, y: 30, width: 320, height: 180 });
    expect(fitCropToRatio({ x: 10, y: 20, width: 100, height: 50 }, 1)).toEqual({ x: 35, y: 20, width: 50, height: 50 });
    expect(fitCropToRatio({ x: 0, y: 0, width: 160, height: 90 }, 9 / 16)).toEqual({ x: 55, y: 0, width: 51, height: 90 });
    // A crop that already has the ratio stays as it is.
    expect(fitCropToRatio({ x: 5, y: 5, width: 160, height: 90 }, 16 / 9)).toEqual({ x: 5, y: 5, width: 160, height: 90 });
  });

  it("keeps a moved crop inside the image", () => {
    const crop = { x: 0, y: 0, width: 100, height: 50 };
    expect(moveCrop(crop, { x: 350, y: -20 }, image)).toEqual({ x: 300, y: 0, width: 100, height: 50 });
    expect(moveCrop(crop, { x: 20.6, y: 30.2 }, image)).toEqual({ x: 21, y: 30, width: 100, height: 50 });
  });

  it("clips a free resize to the image, holding the edges that did not move", () => {
    const from = { x: 10, y: 10, width: 100, height: 100 };
    // The right side dragged past the image.
    expect(resizeCrop(from, { x: 10, y: 10, width: 500, height: 100 }, image)).toEqual({ x: 10, y: 10, width: 390, height: 100 });
    // The top dragged above it.
    expect(resizeCrop(from, { x: 10, y: -40, width: 100, height: 150 }, image)).toEqual({ x: 10, y: 0, width: 100, height: 110 });
  });

  it("keeps the ratio while resizing from a corner, shrinking to fit", () => {
    // Bottom right dragged out: the top left holds.
    expect(resizeCrop({ x: 0, y: 0, width: 160, height: 90 }, { x: 0, y: 0, width: 320, height: 100 }, image, 16 / 9)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    });
    expect(resizeCrop({ x: 200, y: 100, width: 100, height: 50 }, { x: 200, y: 100, width: 300, height: 150 }, image, 2)).toEqual({
      x: 200,
      y: 100,
      width: 200,
      height: 100,
    });
    // Top left dragged out: the bottom right holds.
    expect(resizeCrop({ x: 100, y: 100, width: 100, height: 50 }, { x: 50, y: 75, width: 150, height: 75 }, image, 2)).toEqual({
      x: 50,
      y: 75,
      width: 150,
      height: 75,
    });
  });

  it("turns a crop drawn on show back into capture pixels", () => {
    const shown = { x: 10, y: 20, width: 160, height: 90 };
    // Unturned, the two are the same.
    expect(cropToCapture(shown, image, IDENTITY)).toEqual(shown);
    // A quarter turn: the 400×300 capture shows 300×400, and a 16:9 box on show is 9:16 in the capture.
    const turned = { rotation: 90 as const, flipX: false, flipY: false };
    expect(cropToCapture(shown, image, turned)).toEqual({ x: 20, y: 130, width: 90, height: 160 });
    // Every turn and mirror round-trips through orientRect.
    for (const rotation of [0, 90, 180, 270] as const) {
      for (const flipX of [false, true]) {
        const o = { rotation, flipX, flipY: !flipX && rotation === 180 };
        const crop = cropToCapture(shown, image, o);
        expect(orientRect(crop, image, o)).toEqual(shown);
      }
    }
  });

  it("keeps the old crop when a resize would leave almost nothing", () => {
    const from = { x: 10, y: 10, width: 100, height: 100 };
    expect(resizeCrop(from, { x: 10, y: 10, width: 1, height: 100 }, image)).toEqual(from);
  });
});

describe("move and resize", () => {
  const arrow: Shape = { id: "a", type: "arrow", color: "red", strokeWidth: 2, points: [10, 10, 20, 30] };
  const rect: Shape = { id: "r", type: "rect", color: "red", strokeWidth: 2, x: 10, y: 10, width: 20, height: 40 };

  it("moves point shapes by offsetting every point", () => {
    expect(moveShape(arrow, 5, -5)).toMatchObject({ points: [15, 5, 25, 25] });
  });

  it("moves boxes by their corner", () => {
    expect(moveShape(rect, 5, -5)).toMatchObject({ x: 15, y: 5, width: 20, height: 40 });
  });

  it("absorbs a resize into the shape's size", () => {
    expect(transformShape(rect, { x: 12, y: 8, scaleX: 2, scaleY: 0.5 })).toMatchObject({ x: 12, y: 8, width: 40, height: 20 });
    expect(transformShape(arrow, { x: 0, y: 0, scaleX: 2, scaleY: 1 })).toMatchObject({ points: [20, 10, 40, 30] });
  });

  it("scales text by font size and steps by radius", () => {
    const text: Shape = { id: "t", type: "text", color: "red", x: 0, y: 0, text: "Hi", fontSize: 20 };
    const step: Shape = { id: "s", type: "step", color: "red", x: 0, y: 0, radius: 10 };
    expect(transformShape(text, { x: 1, y: 2, scaleX: 2, scaleY: 2 })).toMatchObject({ x: 1, y: 2, fontSize: 40 });
    expect(transformShape(step, { x: 1, y: 2, scaleX: 1.5, scaleY: 1.5 })).toMatchObject({ radius: 15 });
  });

  it("resizes text and steps from whichever axis was stretched", () => {
    const text: Shape = { id: "t", type: "text", color: "red", x: 0, y: 0, text: "Hi", fontSize: 20 };
    const step: Shape = { id: "s", type: "step", color: "red", x: 0, y: 0, radius: 10 };
    expect(transformShape(text, { x: -10, y: 0, scaleX: 1.5, scaleY: 1 })).toMatchObject({ fontSize: 30 });
    expect(transformShape(step, { x: 0, y: -5, scaleX: 1, scaleY: 2 })).toMatchObject({ radius: 20 });
    expect(transformShape(step, { x: 0, y: 0, scaleX: 1, scaleY: 0.8 })).toMatchObject({ radius: 8 });
  });

  it("offers text and steps only corner handles", () => {
    const text: Shape = { id: "t", type: "text", color: "red", x: 0, y: 0, text: "Hi", fontSize: 20 };
    const step: Shape = { id: "s", type: "step", color: "red", x: 0, y: 0, radius: 10 };
    expect(anchorsFor(text)).toEqual(CORNER_ANCHORS);
    expect(anchorsFor(step)).toEqual(CORNER_ANCHORS);
    expect(anchorsFor(rect)).toEqual(ALL_ANCHORS);
    expect(anchorsFor(null)).toEqual(ALL_ANCHORS);
  });

  it("restyles colour and width, never the blur", () => {
    expect(restyleShape(rect, { color: "blue", strokeWidth: 10 })).toMatchObject({ color: "blue", strokeWidth: 10 });
    const blur: Shape = { id: "b", type: "blur", x: 0, y: 0, width: 5, height: 5, pixelSize: 8 };
    expect(restyleShape(blur, { color: "blue" })).toBe(blur);
  });
});

describe("style options", () => {
  const rect: Shape = { id: "r", type: "rect", color: "#e5484d", strokeWidth: 2, x: 0, y: 0, width: 5, height: 5 };
  const text: Shape = { id: "t", type: "text", color: "#e5484d", x: 0, y: 0, text: "Hi", fontSize: 20 };
  const blur: Shape = { id: "b", type: "blur", x: 0, y: 0, width: 5, height: 5, pixelSize: 8 };
  const spotlight: Shape = { id: "s", type: "spotlight", x: 0, y: 0, width: 5, height: 5 };

  it("toggles fill on boxes and background on text only", () => {
    expect(restyleShape(rect, { fill: true })).toMatchObject({ fill: true });
    expect(restyleShape({ ...rect, fill: true }, { fill: false })).toMatchObject({ fill: false });
    expect(restyleShape(text, { background: true })).toMatchObject({ background: true });
    expect(restyleShape(text, { fill: true })).toBe(text);
    expect(restyleShape(rect, { background: true })).toBe(rect);
  });

  it("sets a text's look, keeping only the field the look uses", () => {
    const outlined = restyleShape(text, textLookStyle("outline"));
    expect(outlined).toEqual({ ...text, textStyle: "outline" });
    const pill = restyleShape(outlined, textLookStyle("pill"));
    expect(pill).toEqual({ ...text, background: true });
    expect(restyleShape(pill, textLookStyle("shadow"))).toEqual({ ...text, textStyle: "shadow" });
    expect(restyleShape(pill, textLookStyle("plain"))).toEqual(text);
    // A look it already has changes nothing.
    expect(restyleShape(pill, textLookStyle("pill"))).toBe(pill);
    expect(restyleShape(text, textLookStyle("plain"))).toBe(text);
    expect(restyleShape(rect, textLookStyle("outline"))).toBe(rect);
  });

  it("reads Pill over a text style, then the text style, then Plain", () => {
    expect(textLook({})).toBe("plain");
    expect(textLook({ background: false, textStyle: "shadow" })).toBe("shadow");
    expect(textLook({ background: true, textStyle: "outline" })).toBe("pill");
    expect(textLookStyle("plain")).toEqual({ background: false, textStyle: undefined });
    expect(textLookStyle("outline")).toEqual({ background: false, textStyle: "outline" });
  });

  it("switches the blur mode, leaving an unchanged blur alone", () => {
    expect(restyleShape(blur, { blurMode: "blur" })).toMatchObject({ mode: "blur" });
    expect(restyleShape(blur, { blurMode: "pixelate" })).toBe(blur);
    expect(restyleShape({ ...blur, mode: "blur" }, { blurMode: "pixelate" })).toMatchObject({ mode: "pixelate" });
  });

  it("never restyles a spotlight", () => {
    expect(restyleShape(spotlight, { color: "blue", strokeWidth: 10, fill: true })).toBe(spotlight);
  });

  it("steps the stroke width through the presets and stops at the ends", () => {
    expect(STROKE_WIDTHS).toEqual([1, 2, 3, 4, 6, 8, 12, 16, 24]);
    expect(stepStrokeWidth(4, 1)).toBe(6);
    expect(stepStrokeWidth(4, -1)).toBe(3);
    expect(stepStrokeWidth(1, -1)).toBe(1);
    expect(stepStrokeWidth(16, 1)).toBe(24);
    expect(stepStrokeWidth(24, 1)).toBe(24);
    // A width between presets moves to the nearest one in that direction.
    expect(stepStrokeWidth(5, 1)).toBe(6);
    expect(stepStrokeWidth(5, -1)).toBe(4);
  });

  it("steps through other presets when given them", () => {
    expect(stepStrokeWidth(DEFAULT_FONT_SIZE, 1, FONT_SIZES)).toBe(36);
    expect(stepStrokeWidth(DEFAULT_STEP_RADIUS, -1, STEP_RADII)).toBe(16);
  });

  it("resizes text and badges, and widens the highlighter by its own rule", () => {
    const step: Shape = { id: "s", type: "step", color: "red", x: 0, y: 0, radius: 20 };
    const highlight: Shape = { id: "h", type: "highlighter", color: "red", strokeWidth: 18, points: [0, 0, 5, 5] };
    expect(restyleShape(text, { fontSize: 48 })).toMatchObject({ fontSize: 48 });
    expect(restyleShape(step, { stepRadius: 30 })).toMatchObject({ radius: 30 });
    // A stroke width leaves text and badge sizes alone.
    expect(restyleShape(text, { strokeWidth: 12 })).toBe(text);
    expect(restyleShape(step, { strokeWidth: 12 })).toBe(step);
    expect(restyleShape(rect, { fontSize: 48, stepRadius: 30 })).toBe(rect);
    expect(restyleShape(highlight, { strokeWidth: 8 })).toMatchObject({ strokeWidth: highlighterWidth(8) });
    expect(highlighterWidth(8)).toBe(24);
    expect(highlighterWidth(2)).toBe(HIGHLIGHTER_WIDTH);
    expect(restyleShape(highlight, { strokeWidth: 4 })).toBe(highlight);
  });

  it("fades hex colours and picks readable text for a background", () => {
    expect(withAlpha("#ff0000", 0.25)).toBe("rgba(255, 0, 0, 0.25)");
    expect(withAlpha("#0f0", 0.5)).toBe("rgba(0, 255, 0, 0.5)");
    expect(withAlpha("tomato", 0.25)).toBe("tomato");
    expect(contrastColor("#ffffff")).toBe("#1f2328");
    expect(contrastColor("#f5a524")).toBe("#1f2328");
    expect(contrastColor("#1f2328")).toBe("#ffffff");
    expect(contrastColor("#e5484d")).toBe("#ffffff");
    expect(textShadowColor("#ffffff")).toBe("#000000");
    expect(textShadowColor("#e5484d")).toBe("#000000");
    expect(textShadowColor("#1f2328")).toBe("#ffffff");
  });
});

describe("duplicate and nudge", () => {
  it("duplicates a shape 12px down and right under a new id", () => {
    const rect: Shape = { id: "r", type: "rect", color: "red", strokeWidth: 2, x: 10, y: 10, width: 20, height: 40, fill: true };
    expect(duplicateShape(rect, "copy")).toEqual({ ...rect, id: "copy", x: 22, y: 22 });
    const arrow: Shape = { id: "a", type: "arrow", color: "red", strokeWidth: 2, points: [10, 10, 20, 30] };
    expect(duplicateShape(arrow, "copy")).toEqual({ ...arrow, id: "copy", points: [22, 22, 32, 42] });
    expect(duplicateShape(arrow).id).not.toBe("a");
  });

  it("nudges by 1px, or 10px with Shift", () => {
    expect(nudgeDelta("ArrowLeft", false)).toEqual({ x: -1, y: 0 });
    expect(nudgeDelta("ArrowRight", true)).toEqual({ x: 10, y: 0 });
    expect(nudgeDelta("ArrowUp", false)).toEqual({ x: 0, y: -1 });
    expect(nudgeDelta("ArrowDown", true)).toEqual({ x: 0, y: 10 });
    expect(nudgeDelta("a", false)).toBeNull();
  });

  it("moves a spotlight like any box", () => {
    const spotlight: Shape = { id: "s", type: "spotlight", x: 10, y: 10, width: 20, height: 40 };
    expect(moveShape(spotlight, 1, -1)).toEqual({ ...spotlight, x: 11, y: 9 });
    expect(transformShape(spotlight, { x: 0, y: 0, scaleX: 2, scaleY: 0.5 })).toMatchObject({ width: 40, height: 20 });
  });
});

describe("spotlight", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 80 };
  const area = (rects: { width: number; height: number }[]) => rects.reduce((sum, rect) => sum + rect.width * rect.height, 0);

  it("dims nothing without a spotlight", () => {
    expect(spotlightDim(bounds, [])).toEqual([]);
    // One wholly outside the capture lights nothing, so nothing is dimmed either.
    expect(spotlightDim(bounds, [{ x: 200, y: 200, width: 10, height: 10 }])).toEqual([]);
  });

  it("dims everything around one spotlight", () => {
    expect(spotlightDim(bounds, [{ x: 20, y: 10, width: 30, height: 40 }])).toEqual([
      { x: 0, y: 0, width: 100, height: 10 },
      { x: 0, y: 10, width: 20, height: 40 },
      { x: 50, y: 10, width: 50, height: 40 },
      { x: 0, y: 50, width: 100, height: 30 },
    ]);
  });

  it("keeps the union of overlapping spotlights bright, without overlapping shade", () => {
    const holes = [
      { x: 10, y: 10, width: 40, height: 40 },
      { x: 30, y: 30, width: 40, height: 40 },
    ];
    const dim = spotlightDim(bounds, holes);
    // Union: 1600 + 1600 - the 20x20 overlap.
    expect(area(dim)).toBe(100 * 80 - 2800);
    const inside = (rect: (typeof dim)[number], x: number, y: number) => x > rect.x && x < rect.x + rect.width && y > rect.y && y < rect.y + rect.height;
    expect(dim.some((rect) => inside(rect, 40, 40))).toBe(false);
    expect(dim.some((rect) => inside(rect, 60, 20))).toBe(true);
  });

  it("clips a spotlight to the capture and accepts one still being dragged", () => {
    // Dragged up and left from 30, 20 past the corner.
    const dim = spotlightDim(bounds, [{ x: 30, y: 20, width: -50, height: -40 }]);
    expect(area(dim)).toBe(100 * 80 - 30 * 20);
  });
});

describe("document edits", () => {
  it("adds, replaces and deletes without mutating", () => {
    const empty = emptyAnnotations();
    const rect: Shape = { id: "r", type: "rect", color: "red", strokeWidth: 2, x: 0, y: 0, width: 5, height: 5 };
    const added = addShape(empty, rect);
    expect(empty.shapes).toEqual([]);
    const moved = replaceShape(added, moveShape(rect, 1, 1));
    expect(moved.shapes[0]).toMatchObject({ x: 1, y: 1 });
    expect(added.shapes[0]).toBe(rect);
    expect(deleteShape(moved, "r").shapes).toEqual([]);
  });
});

describe("per-tool widths", () => {
  it("gives each tool its own kind of width", () => {
    expect(widthKind("arrow")?.presets).toBe(STROKE_WIDTHS);
    expect(widthKind("highlighter")?.presets).toBe(STROKE_WIDTHS);
    expect(widthKind("text")?.presets).toBe(FONT_SIZES);
    expect(widthKind("step")?.presets).toBe(STEP_RADII);
    expect(widthKind("blur")).toBeNull();
    expect(widthKind("select")).toBeNull();
  });

  it("remembers a width per tool and falls back to each default", () => {
    const widths = { arrow: 12, text: 48 };
    expect(widthFor(widths, "arrow")).toBe(12);
    expect(widthFor(widths, "rect")).toBe(4);
    expect(widthFor(widths, "text")).toBe(48);
    expect(widthFor(widths, "step")).toBe(DEFAULT_STEP_RADIUS);
    expect(widthFor({}, "text")).toBe(DEFAULT_FONT_SIZE);
  });

  it("finds the preset nearest a width", () => {
    expect(nearestPreset(STROKE_WIDTHS, 4)).toBe(3);
    expect(nearestPreset(STROKE_WIDTHS, 11)).toBe(6);
    // A tie keeps the thinner preset.
    expect(nearestPreset(STROKE_WIDTHS, 10)).toBe(5);
    expect(nearestPreset(STROKE_WIDTHS, 100)).toBe(8);
    expect(nearestPreset(STROKE_WIDTHS, 0)).toBe(0);
  });

  it("draws badges at the style's size, not from the stroke width", () => {
    expect(beginShape("step", { x: 0, y: 0 }, { ...style, strokeWidth: 24 }, "s")).toMatchObject({ radius: DEFAULT_STEP_RADIUS });
    expect(beginShape("step", { x: 0, y: 0 }, { ...style, stepRadius: 36 }, "s")).toMatchObject({ radius: 36 });
  });
});

describe("curved arrows and lines", () => {
  const straight: LineShape = { id: "a", type: "arrow", color: "red", strokeWidth: 2, points: [0, 0, 100, 0] };
  const curved: LineShape = { ...straight, control: [50, -40] };

  it("puts the bend handle on the curve's midpoint, or the chord's when straight", () => {
    expect(curveMidpoint(straight)).toEqual({ x: 50, y: 0 });
    expect(curveMidpoint(curved)).toEqual({ x: 50, y: -20 });
  });

  it("finds the control point that runs the curve through the handle", () => {
    expect(controlFromHandle({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: -20 })).toEqual([50, -40]);
    // A handle off to one side gives a lopsided curve that still passes through it.
    const control = controlFromHandle({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 70, y: 30 });
    expect(curveMidpoint({ ...straight, control })).toEqual({ x: 70, y: 30 });
  });

  it("bends a straight line and straightens it within the snap distance", () => {
    const bent = bendLine(straight, { x: 50, y: -20 }, 6);
    expect(bent.control).toEqual([50, -40]);
    const back = bendLine(bent, { x: 52, y: 3 }, 6);
    expect(back).not.toHaveProperty("control");
    expect(back).toEqual(straight);
    // Just past the snap it stays curved.
    expect(bendLine(bent, { x: 50, y: 7 }, 6).control).toEqual([50, 14]);
  });

  it("draws a curve as one cubic segment ending along the end tangent", () => {
    expect(curvePoints(straight)).toEqual([0, 0, 100, 0]);
    const points = curvePoints({ ...straight, control: [60, -30] });
    expect(points).toHaveLength(8);
    expect(points.slice(0, 2)).toEqual([0, 0]);
    expect(points.slice(6)).toEqual([100, 0]);
    expect(points[2]).toBeCloseTo(40);
    expect(points[3]).toBeCloseTo(-20);
    expect(points[4]).toBeCloseTo(73.333, 2);
    expect(points[5]).toBeCloseTo(-20);
    // The last control point lies on the line from the end to the quadratic's control: the end tangent.
    const tangent = Math.atan2(0 - -30, 100 - 60);
    expect(Math.atan2(points[7] - points[5], points[6] - points[4])).toBeCloseTo(tangent);
  });

  it("keeps the bend when an end moves", () => {
    expect(moveLineEnd(straight, 1, { x: 200, y: 0 })).toEqual({ ...straight, points: [0, 0, 200, 0] });
    const stretched = moveLineEnd(curved, 1, { x: 200, y: 0 });
    expect(stretched.points).toEqual([0, 0, 200, 0]);
    // The bend scales with the line: twice as long, twice as deep.
    expect(curveMidpoint(stretched).x).toBeCloseTo(100);
    expect(curveMidpoint(stretched).y).toBeCloseTo(-40);
    const turned = moveLineEnd(curved, 0, { x: 100, y: 100 });
    expect(turned.points).toEqual([100, 100, 100, 0]);
    // The bend turns with the line, staying on the same side of it.
    expect(curveMidpoint(turned).x).toBeCloseTo(80);
    expect(curveMidpoint(turned).y).toBeCloseTo(50);
  });

  it("moves, resizes and duplicates the control point with the line", () => {
    expect(moveShape(curved, 5, 10)).toEqual({ ...curved, points: [5, 10, 105, 10], control: [55, -30] });
    expect(transformShape(curved, { x: 0, y: 0, scaleX: 2, scaleY: 0.5 })).toMatchObject({ points: [0, 0, 200, 0], control: [100, -20] });
    expect(duplicateShape(curved, "copy")).toEqual({ ...curved, id: "copy", points: [12, 12, 112, 12], control: [62, -28] });
    expect(moveShape(straight, 5, 10)).not.toHaveProperty("control");
  });

  it("gives arrows and lines their own handles instead of the box", () => {
    expect(hasLineHandles(straight)).toBe(true);
    expect(hasLineHandles({ ...straight, type: "line" })).toBe(true);
    expect(hasLineHandles({ id: "f", type: "freehand", color: "red", strokeWidth: 2, points: [0, 0, 1, 1] })).toBe(false);
    expect(hasLineHandles(null)).toBe(false);
  });
});

describe("crop snapping", () => {
  const image = { width: 400, height: 300 };
  const lines = { x: [100], y: [80] };
  const right = { left: false, right: true, top: false, bottom: false };
  const bottomRight = { left: false, right: true, top: false, bottom: true };
  const topLeft = { left: true, right: false, top: true, bottom: false };

  it("finds the nearest line within the threshold", () => {
    expect(nearestLine(97, [0, 100, 400], 6)).toBe(100);
    expect(nearestLine(3, [0, 100, 400], 6)).toBe(0);
    expect(nearestLine(50, [0, 100, 400], 6)).toBeNull();
  });

  it("reads the moving sides from a handle's anchor", () => {
    expect(anchorSides("top-left")).toEqual(topLeft);
    expect(anchorSides("middle-right")).toEqual(right);
    expect(anchorSides("bottom-center")).toEqual({ left: false, right: false, top: false, bottom: true });
  });

  it("keeps the far side still when the handles scale from the centre", () => {
    expect(holdCropSides({ x: 10, y: 10, width: 100, height: 50 }, { x: 0, y: 10, width: 120, height: 50 }, right)).toEqual({
      x: 10,
      y: 10,
      width: 110,
      height: 50,
    });
  });

  it("snaps a moving side to a line or the image border within the threshold", () => {
    expect(snapCropEdges({ x: 10, y: 10, width: 95, height: 50 }, right, lines, 6, image)).toEqual({ x: 10, y: 10, width: 90, height: 50 });
    expect(snapCropEdges({ x: 10, y: 10, width: 385, height: 50 }, right, lines, 6, image)).toEqual({ x: 10, y: 10, width: 390, height: 50 });
    expect(snapCropEdges({ x: 97, y: 77, width: 50, height: 50 }, topLeft, lines, 6, image)).toEqual({ x: 100, y: 80, width: 47, height: 47 });
  });

  it("leaves sides past the threshold, and sides that are not moving, alone", () => {
    const crop = { x: 10, y: 10, width: 97, height: 72 };
    expect(snapCropEdges(crop, right, lines, 6, image)).toEqual(crop);
    // The bottom (82) is near the line at 80, but only the right side moves.
    expect(snapCropEdges(crop, right, lines, 7, image)).toEqual({ ...crop, width: 90 });
  });

  it("shifts a moved crop to whichever side is nearer a line, keeping its size", () => {
    expect(snapCropEdges({ x: 96, y: 40, width: 50, height: 30 }, ALL_SIDES, lines, 6, image)).toEqual({ x: 100, y: 40, width: 50, height: 30 });
    expect(snapCropEdges({ x: 2, y: 50, width: 95, height: 20 }, ALL_SIDES, lines, 6, image)).toEqual({ x: 0, y: 50, width: 95, height: 20 });
  });

  it("keeps the ratio: the dragged side snaps and the other follows", () => {
    expect(snapCropEdges({ x: 10, y: 10, width: 92, height: 46 }, bottomRight, lines, 6, image, 2)).toEqual({ x: 10, y: 10, width: 90, height: 45 });
    expect(snapCropEdges({ x: 97, y: 150, width: 100, height: 50 }, topLeft, lines, 6, image, 2)).toEqual({ x: 100, y: 151, width: 97, height: 49 });
  });

  it("takes the nearer snap at a corner, and drops one that would leave the image", () => {
    expect(snapCropEdges({ x: 20, y: 20, width: 82, height: 57 }, bottomRight, lines, 6, image, 1)).toEqual({ x: 20, y: 20, width: 80, height: 80 });
    expect(snapCropEdges({ x: 20, y: 20, width: 84, height: 59 }, bottomRight, lines, 6, image, 1)).toEqual({ x: 20, y: 20, width: 60, height: 60 });
    // Snapping the right side to the border would make it 50 tall, past the bottom.
    expect(snapCropEdges({ x: 300, y: 255, width: 96, height: 40 }, bottomRight, lines, 6, image, 2)).toEqual({ x: 300, y: 255, width: 90, height: 45 });
  });

  it("snaps a crop drag's start corner and dragged sides", () => {
    expect(snapCropDrag({ x: 3, y: 3 }, { x: 97, y: 50 }, image, null, lines, 6)).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(snapCropDrag({ x: 3, y: 3 }, { x: 95, y: 60 }, image, 1, lines, 6)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(snapCropDrag({ x: 20, y: 20 }, { x: 60, y: 50 }, image, null, lines, 6)).toEqual({ x: 20, y: 20, width: 40, height: 30 });
  });

  it("leaves a stray click near a corner too small to crop", () => {
    expect(snapCropDrag({ x: 398, y: 298 }, { x: 399, y: 299 }, image, null, lines, 6)).toEqual({ x: 398, y: 298, width: 1, height: 1 });
  });
});

describe("crop on a grown canvas", () => {
  // A 400×300 capture with an image to its left and one past its right, as they show.
  const canvas = { x: -100, y: 0, width: 900, height: 340 };

  it("lets a crop drag reach past the capture, up to the canvas", () => {
    expect(cropBox({ x: -150, y: 10 }, { x: 900, y: 400 }, canvas)).toEqual({ x: -100, y: 10, width: 900, height: 330 });
    expect(cropFromDrag({ x: 350, y: 0 }, { x: 450, y: 100 }, canvas)).toEqual({ x: 350, y: 0, width: 100, height: 100 });
    // A ratio crop shrinks to fit the room left to the canvas edge it heads for.
    expect(cropBox({ x: -50, y: 300 }, { x: -200, y: 200 }, canvas, 1)).toEqual({ x: -100, y: 250, width: 50, height: 50 });
  });

  it("moves and resizes a crop within the canvas", () => {
    const crop = { x: 0, y: 0, width: 200, height: 100 };
    expect(moveCrop(crop, { x: -300, y: 500 }, canvas)).toEqual({ x: -100, y: 240, width: 200, height: 100 });
    expect(moveCrop(crop, { x: 750, y: 0 }, canvas)).toEqual({ x: 600, y: 0, width: 200, height: 100 });
    expect(resizeCrop(crop, { x: -500, y: 0, width: 700, height: 100 }, canvas)).toEqual({ x: -100, y: 0, width: 300, height: 100 });
  });

  it("snaps to the canvas edges and the capture's own", () => {
    const lines = withCaptureBorders({ x: [100], y: [] }, { width: 400, height: 300 });
    expect(lines).toEqual({ x: [0, 100, 400], y: [0, 300] });
    const right = { left: false, right: true, top: false, bottom: false };
    // The capture's right border, then the canvas edge past it.
    expect(snapCropEdges({ x: 10, y: 10, width: 393, height: 50 }, right, lines, 6, canvas)).toEqual({ x: 10, y: 10, width: 390, height: 50 });
    expect(snapCropEdges({ x: 10, y: 10, width: 786, height: 50 }, right, lines, 6, canvas)).toEqual({ x: 10, y: 10, width: 790, height: 50 });
    // A moved crop shifts onto the canvas's left edge, which is past the capture's.
    expect(snapCropEdges({ x: -97, y: 50, width: 50, height: 20 }, ALL_SIDES, lines, 6, canvas)).toEqual({ x: -100, y: 50, width: 50, height: 20 });
    expect(snapCropDrag({ x: -96, y: 3 }, { x: 397, y: 297 }, canvas, null, lines, 6)).toEqual({ x: -100, y: 0, width: 500, height: 300 });
  });

  it("keeps the capture's own bounds when nothing grows it", () => {
    const image = { width: 400, height: 300 };
    expect(cropBox({ x: -10, y: -10 }, { x: 500, y: 500 }, image)).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(cropBox({ x: -10, y: -10 }, { x: 500, y: 500 }, { x: 0, y: 0, ...image })).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it("maps a crop past a turned capture back to capture pixels", () => {
    const capture = { width: 400, height: 300 };
    const turned = { rotation: 90 as const, flipX: false, flipY: false };
    // An image right of the capture shows below it once turned a quarter clockwise.
    const crop = { x: 0, y: 0, width: 800, height: 300 };
    const shown = orientRect(crop, capture, turned);
    expect(shown).toEqual({ x: 0, y: 0, width: 300, height: 800 });
    expect(cropToCapture(shown, capture, turned)).toEqual(crop);
  });
});

describe("magnify lenses", () => {
  const style: Style = { color: "#0090ff", strokeWidth: 4 };
  const lens = { id: "m", type: "magnify" as const, x: 100, y: 120, width: 80, height: 80,
    color: style.color, strokeWidth: 4, spot: [40, 50] as [number, number], zoom: 2 };

  it("draws a square in either direction and puts its spot at the centre", () => {
    const started = beginShape("magnify", { x: 100, y: 100 }, style, "m")!;
    expect(started).toMatchObject({ zoom: 2, spot: [100, 100] });
    expect(finishShape(dragShape(started, { x: 60, y: 80 }))).toMatchObject({ x: 60, y: 60, width: 40, height: 40, spot: [80, 80] });
    expect(finishShape(dragShape(started, { x: 130, y: 150 }))).toMatchObject({ width: 50, height: 50, spot: [125, 125] });
    expect(finishShape(started)).toBeNull();
  });
  it("keeps the spot fixed on drag and resize, with corner anchors only", () => {
    expect(transformShape(lens, { x: 200, y: 220, scaleX: 1, scaleY: 1 })).toMatchObject({ x: 200, y: 220, spot: [40, 50] });
    expect(transformShape(lens, { x: 90, y: 110, scaleX: 2, scaleY: 1 })).toMatchObject({ width: 160, height: 160, spot: [40, 50] });
    expect(transformShape(lens, { x: 90, y: 110, scaleX: 0.5, scaleY: 1 })).toMatchObject({ width: 40, height: 40 });
    expect(anchorsFor(lens)).toEqual(CORNER_ANCHORS);
    expect(widthKind("magnify")?.label).toBe("Width");
  });
  it("nudges and duplicates both lens and spot together", () => {
    expect(moveShape(lens, 1, -10)).toMatchObject({ x: 101, y: 110, spot: [41, 40] });
    expect(duplicateShape(lens, "copy", 12)).toMatchObject({ id: "copy", x: 112, y: 132, spot: [52, 62] });
    expect(lens.spot).toEqual([40, 50]);
  });
  it("restyles border, zoom, outline and the line, including turning options off", () => {
    const changed = restyleShape(lens, { zoom: 6, lens: "square", lensLine: true, color: "#ffffff", strokeWidth: 8 });
    expect(changed).toMatchObject({ zoom: 6, lens: "square", line: true, color: "#ffffff", strokeWidth: 8, spot: [40, 50] });
    expect(restyleShape(changed, { lens: "round", lensLine: false })).toMatchObject({ lens: undefined, line: undefined });
    expect(beginShape("magnify", { x: 0, y: 0 }, { ...style, zoom: 4, lens: "square", lensLine: true })).toMatchObject({ zoom: 4, lens: "square", line: true });
  });
});

describe("callouts", () => {
  const callout: Shape = { id: "c", type: "callout", color: "red", x: 100, y: 50, text: "Here", fontSize: 20, tail: { x: 40, y: 120 } };

  it("moves the bubble and the tip together", () => {
    expect(moveShape(callout, 5, -5)).toMatchObject({ x: 105, y: 45, tail: { x: 45, y: 115 } });
    expect(transformShape(callout, { x: 130, y: 60, scaleX: 1, scaleY: 1 })).toMatchObject({ x: 130, y: 60, tail: { x: 70, y: 130 } });
  });

  it("scales by font size on a resize, leaving the tip on its target", () => {
    expect(transformShape(callout, { x: 90, y: 40, scaleX: 1.5, scaleY: 1.5 })).toMatchObject({
      x: 90,
      y: 40,
      fontSize: 30,
      tail: { x: 40, y: 120 },
    });
  });

  it("duplicates with the tip, offset from the original", () => {
    const copy = duplicateShape(callout, "copy");
    expect(copy).toMatchObject({ id: "copy", x: 112, y: 62, tail: { x: 52, y: 132 } });
    expect(callout).toMatchObject({ x: 100, tail: { x: 40, y: 120 } });
  });

  it("offers only corner handles", () => {
    expect(anchorsFor(callout)).toEqual(CORNER_ANCHORS);
  });

  it("restyles colour, text size and background like text, ignoring stroke width and fill", () => {
    expect(restyleShape(callout, { color: "blue", fontSize: 36, background: true })).toMatchObject({
      color: "blue",
      fontSize: 36,
      background: true,
      tail: { x: 40, y: 120 },
    });
    expect(restyleShape(callout, { strokeWidth: 12 })).toBe(callout);
    expect(restyleShape(callout, { fill: true })).toBe(callout);
  });
});

describe("added images", () => {
  const image: ImageShape = { id: "i", type: "image", src: "added.png", x: 10, y: 20, width: 200, height: 100 };

  it("moves, resizes from the corners keeping its ratio, and duplicates", () => {
    expect(moveShape(image, 5, -5)).toMatchObject({ x: 15, y: 15, width: 200, height: 100 });
    expect(transformShape(image, { x: 0, y: 0, scaleX: 2, scaleY: 2 })).toMatchObject({ x: 0, y: 0, width: 400, height: 200 });
    // Shift frees the ratio: the Transformer then scales the axes apart.
    expect(transformShape(image, { x: 0, y: 0, scaleX: 0.5, scaleY: 2 })).toMatchObject({ width: 100, height: 200 });
    expect(keepsRatio(image)).toBe(true);
    expect(anchorsFor(image)).toEqual(CORNER_ANCHORS);
    const copy = duplicateShape(image, "j") as ImageShape;
    expect(copy).toMatchObject({ id: "j", type: "image", src: "added.png", width: 200, height: 100 });
    expect(copy.x).toBeGreaterThan(image.x);
    expect(nudgeDelta("ArrowLeft", false)).toEqual({ x: -1, y: 0 });
  });

  it("ignores colours and widths", () => {
    expect(restyleShape(image, { color: "#ffffff", strokeWidth: 8 })).toBe(image);
  });

  it("is placed centred on a drop, or just right of the canvas on paste", () => {
    expect(imageAt("a.png", { width: 100, height: 50 }, { x: 300, y: 200 }, "a")).toEqual({
      id: "a", type: "image", src: "a.png", x: 250, y: 175, width: 100, height: 50,
    });
    expect(imageBeside("b.png", { width: 80, height: 60 }, { x: -20, y: -10, width: 420, height: 310 }, "b")).toEqual({
      id: "b", type: "image", src: "b.png", x: 400, y: 0, width: 80, height: 60,
    });
  });

  it("grows the canvas to the capture and every image", () => {
    const size = { width: 400, height: 300 };
    expect(canvasBounds(size, [])).toEqual({ x: 0, y: 0, width: 400, height: 300 });
    expect(canvasBounds(size, [{ ...image, x: 400, y: 0, width: 400, height: 350 }])).toEqual({ x: 0, y: 0, width: 800, height: 350 });
    expect(canvasBounds(size, [{ ...image, x: -50.5, y: -10, width: 20, height: 20 }])).toEqual({ x: -51, y: -10, width: 451, height: 310 });
    // Other shapes never grow it, and an image inside leaves it as it is.
    const rect: Shape = { id: "r", type: "rect", color: "#000000", strokeWidth: 2, x: 900, y: 900, width: 10, height: 10 };
    expect(canvasBounds(size, [rect, image])).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });
});

describe("drawing order", () => {
  const doc = {
    ...emptyAnnotations(),
    shapes: ["a", "b", "c"].map((id): Shape => ({ id, type: "spotlight", x: 0, y: 0, width: 10, height: 10 })),
  };
  const ids = (shapes: Shape[]) => shapes.map((shape) => shape.id);

  it("brings a shape forward and sends it backward one place", () => {
    expect(ids(reorderShape(doc, "a", 1).shapes)).toEqual(["b", "a", "c"]);
    expect(ids(reorderShape(doc, "c", -1).shapes)).toEqual(["a", "c", "b"]);
  });

  it("leaves the document as it is at either end or for an unknown shape", () => {
    expect(reorderShape(doc, "c", 1)).toBe(doc);
    expect(reorderShape(doc, "a", -1)).toBe(doc);
    expect(reorderShape(doc, "zz", 1)).toBe(doc);
  });
});
