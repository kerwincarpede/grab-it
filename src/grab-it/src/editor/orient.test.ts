import { describe, expect, it } from "vitest";
import {
  clampScale,
  displaySize,
  flip,
  groupTransform,
  IDENTITY,
  isIdentity,
  normalizeRotation,
  orientationOf,
  orientRect,
  rotate,
  scaledSize,
  scaleFrom,
  shownTextCorner,
  textCorner,
  toCapture,
  toCaptureDelta,
  toDisplay,
  uprightTransform,
  withOrientation,
  withScale,
  type Orientation,
} from "./orient";
import type { Point } from "./model";

const size = { width: 400, height: 300 };
const right: Orientation = { rotation: 90, flipX: false, flipY: false };

/** Where Konva draws a point through a node's attributes: scale, then rotate, then move. */
function konva(attrs: { x?: number; y?: number; rotation: number; scaleX: number; scaleY: number }, p: Point): Point {
  const radians = (attrs.rotation * Math.PI) / 180;
  const sx = p.x * attrs.scaleX;
  const sy = p.y * attrs.scaleY;
  return {
    // `|| 0` turns -0 into 0, as toDisplay does.
    x: Math.round(sx * Math.cos(radians) - sy * Math.sin(radians) + (attrs.x ?? 0)) || 0,
    y: Math.round(sx * Math.sin(radians) + sy * Math.cos(radians) + (attrs.y ?? 0)) || 0,
  };
}

const ALL: Orientation[] = ([0, 90, 180, 270] as const).flatMap((rotation) =>
  [false, true].flatMap((flipX) => [false, true].map((flipY) => ({ rotation, flipX, flipY }))),
);

describe("orientation", () => {
  it("reads absent fields as unchanged", () => {
    expect(orientationOf({})).toEqual(IDENTITY);
    expect(isIdentity(orientationOf({ rotation: 0 }))).toBe(true);
    expect(orientationOf({ rotation: 270, flipY: true })).toEqual({ rotation: 270, flipX: false, flipY: true });
  });

  it("keeps rotations to quarter turns", () => {
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(45)).toBeNull();
    expect(normalizeRotation(Number.NaN)).toBeNull();
  });

  it("swaps width and height for a quarter turn", () => {
    expect(displaySize(size, right)).toEqual({ width: 300, height: 400 });
    expect(displaySize(size, { rotation: 180, flipX: true, flipY: false })).toEqual(size);
  });

  it("turns the capture clockwise with its top-left at 0, 0", () => {
    // The top-left corner goes to the top-right; the bottom-left to the top-left.
    expect(toDisplay({ x: 0, y: 0 }, size, right)).toEqual({ x: 300, y: 0 });
    expect(toDisplay({ x: 0, y: 300 }, size, right)).toEqual({ x: 0, y: 0 });
    expect(toDisplay({ x: 400, y: 0 }, size, { rotation: 0, flipX: true, flipY: false })).toEqual({ x: 0, y: 0 });
    expect(toDisplay({ x: 10, y: 20 }, size, { rotation: 180, flipX: false, flipY: false })).toEqual({ x: 390, y: 280 });
  });

  it("maps the pointer back to the same capture pixel", () => {
    for (const o of ALL) {
      const p = { x: 37, y: 211 };
      expect(toCapture(toDisplay(p, size, o), size, o)).toEqual(p);
    }
  });

  it("keeps every orientation inside the display", () => {
    for (const o of ALL) {
      expect(orientRect({ x: 0, y: 0, ...size }, size, o)).toEqual({ x: 0, y: 0, ...displaySize(size, o) });
    }
  });

  it("orients the crop", () => {
    expect(orientRect({ x: 10, y: 20, width: 100, height: 50 }, size, right)).toEqual({ x: 230, y: 10, width: 50, height: 100 });
  });

  it("gives Konva the same transform", () => {
    for (const o of ALL) {
      const attrs = groupTransform(size, o);
      for (const p of [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 13, y: 250 }]) {
        expect(konva(attrs, p)).toEqual(toDisplay(p, size, o));
      }
    }
  });

  it("undoes the turn and mirror for upright text", () => {
    for (const o of ALL) {
      const group = { ...groupTransform(size, o), x: 0, y: 0 };
      const upright = uprightTransform(o);
      const p = { x: 7, y: 3 };
      expect(konva(group, konva(upright, p))).toEqual(p);
    }
  });

  it("turns a nudge on show back into capture pixels", () => {
    // Turned right, right on show is up the capture; flipped, left on show is right.
    expect(toCaptureDelta({ x: 1, y: 0 }, right)).toEqual({ x: 0, y: -1 });
    expect(toCaptureDelta({ x: -10, y: 0 }, { rotation: 0, flipX: true, flipY: false })).toEqual({ x: 10, y: 0 });
    for (const o of ALL) {
      const d = { x: 3, y: -7 };
      const from = toDisplay({ x: 50, y: 60 }, size, o);
      const moved = toCaptureDelta(d, o);
      const to = toDisplay({ x: 50 + moved.x, y: 60 + moved.y }, size, o);
      expect({ x: to.x - from.x, y: to.y - from.y }).toEqual(d);
    }
  });

  it("rotates and flips what is on show", () => {
    expect(rotate(IDENTITY, 1)).toEqual(right);
    expect(rotate(IDENTITY, -1)).toEqual({ rotation: 270, flipX: false, flipY: false });
    expect(rotate(rotate(right, -1), -1)).toEqual({ rotation: 270, flipX: false, flipY: false });
    expect(flip(IDENTITY, "x")).toEqual({ rotation: 0, flipX: true, flipY: false });
    expect(flip(flip(IDENTITY, "y"), "y")).toEqual(IDENTITY);
    // A mirrored image turned right shows as the mirrored image, turned right.
    for (const o of ALL) {
      const turned = rotate(o, 1);
      const p = { x: 25, y: 40 };
      const shown = toDisplay(p, size, o);
      const shownSize = displaySize(size, o);
      // A clockwise quarter turn of the display: (x, y) -> (h - y, x).
      expect(toDisplay(p, size, turned)).toEqual({ x: shownSize.height - shown.y, y: shown.x });
    }
  });

  it("writes only what changed", () => {
    const doc = { version: 1 as const, shapes: [], crop: null, rotation: 90 as const, flipX: true, scale: 2 };
    expect(withOrientation(doc, IDENTITY)).toEqual({ version: 1, shapes: [], crop: null, scale: 2 });
    expect(withOrientation(doc, { rotation: 180, flipX: false, flipY: true })).toMatchObject({ rotation: 180, flipY: true });
    expect(withScale(doc, 1)).not.toHaveProperty("scale");
    expect(withScale(doc, 9).scale).toBe(4);
  });
});

describe("resize", () => {
  const output = { width: 800, height: 600 };

  it("scales from a width or a height, the ratio locked", () => {
    expect(scaleFrom(output, { width: 400 })).toBe(0.5);
    expect(scaleFrom(output, { height: 900 })).toBe(1.5);
    expect(scaledSize(output, 0.5)).toEqual({ width: 400, height: 300 });
  });

  it("scales from a percentage", () => {
    expect(scaleFrom(output, { percent: 25 })).toBe(0.25);
  });

  it("stays within 10% and 400%", () => {
    expect(scaleFrom(output, { percent: 1 })).toBe(0.1);
    expect(scaleFrom(output, { width: 8000 })).toBe(4);
    expect(scaleFrom(output, { width: 0 })).toBeNull();
    expect(scaleFrom(output, { percent: Number.NaN })).toBeNull();
    expect(clampScale(0.5)).toBe(0.5);
  });
});

describe("upright text", () => {
  it("shows its top-left corner where it was placed", () => {
    for (const o of ALL) {
      const shown = { x: 120, y: 80 };
      const corner = textCorner(shown, "Look", 20, size, o);
      const placed = shownTextCorner({ ...corner, text: "Look", fontSize: 20 }, size, o);
      expect(placed.x).toBeCloseTo(shown.x);
      expect(placed.y).toBeCloseTo(shown.y);
    }
  });

  it("is the text's own corner when nothing is turned", () => {
    expect(textCorner({ x: 5, y: 6 }, "Hi", 30, size, IDENTITY)).toEqual({ x: 5, y: 6 });
    expect(shownTextCorner({ x: 5, y: 6, text: "Hi", fontSize: 30 }, size, IDENTITY)).toEqual({ x: 5, y: 6 });
  });
});
