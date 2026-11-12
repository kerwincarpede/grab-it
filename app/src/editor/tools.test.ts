import { describe, expect, it } from "vitest";
import { emptyAnnotations, type Shape, type Style } from "./model";
import {
  addShape,
  beginShape,
  cropFromDrag,
  deleteShape,
  dragShape,
  finishShape,
  HIGHLIGHTER_WIDTH,
  moveShape,
  replaceShape,
  restyleShape,
  stepNumbers,
  transformShape,
} from "./tools";

const style: Style = { color: "#e5484d", strokeWidth: 4 };

/** Draws with `tool` from `from` through `path`, as the editor does. */
function draw(tool: Parameters<typeof beginShape>[0], from: [number, number], ...path: [number, number][]) {
  let shape = beginShape(tool, { x: from[0], y: from[1] }, style, "id");
  if (!shape) return null;
  for (const [x, y] of path) shape = dragShape(shape, { x, y });
  return finishShape(shape);
}

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

  it.each(["rect", "ellipse", "blur"] as const)("normalises a %s dragged up and left", (tool) => {
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

  it("restyles colour and width, never the blur", () => {
    expect(restyleShape(rect, { color: "blue", strokeWidth: 10 })).toMatchObject({ color: "blue", strokeWidth: 10 });
    const blur: Shape = { id: "b", type: "blur", x: 0, y: 0, width: 5, height: 5, pixelSize: 8 };
    expect(restyleShape(blur, { color: "blue" })).toBe(blur);
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
