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
  type Shape,
  type Style,
} from "./model";
import {
  addShape,
  ALL_ANCHORS,
  anchorsFor,
  CORNER_ANCHORS,
  beginShape,
  colorForKey,
  contrastColor,
  cropFromDrag,
  deleteShape,
  dragShape,
  duplicateShape,
  finishShape,
  HIGHLIGHTER_WIDTH,
  highlighterWidth,
  HOLD_MS,
  modifierTool,
  moveShape,
  nudgeDelta,
  releaseRestores,
  replaceShape,
  restyleShape,
  snapAngle,
  spotlightDim,
  squareCorner,
  stepNumbers,
  stepStrokeWidth,
  transformShape,
  withAlpha,
} from "./tools";

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

  it("records every point of a freehand path", () => {
    expect(draw("freehand", [0, 0], [5, 5], [10, 0])).toMatchObject({ points: [0, 0, 5, 5, 10, 0] });
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
    expect(nearestPreset(STROKE_WIDTHS, 10)).toBe(6);
    expect(nearestPreset(STROKE_WIDTHS, 100)).toBe(8);
    expect(nearestPreset(STROKE_WIDTHS, 0)).toBe(0);
  });

  it("draws badges at the style's size, not from the stroke width", () => {
    expect(beginShape("step", { x: 0, y: 0 }, { ...style, strokeWidth: 24 }, "s")).toMatchObject({ radius: DEFAULT_STEP_RADIUS });
    expect(beginShape("step", { x: 0, y: 0 }, { ...style, stepRadius: 36 }, "s")).toMatchObject({ radius: 36 });
  });
});
