import { describe, expect, it } from "vitest";
import type { CapturedPointer } from "./api";
import { emptyAnnotations } from "./model";
import {
  builtInImage,
  builtInSprite,
  changePointerLook,
  MAX_POINTER_SCALE,
  movePointer,
  pointerBox,
  pointerImageSource,
  pointerSprite,
  pointerState,
  showPointer,
  transformPointer,
  withPointer,
} from "./pointer";

const captured: CapturedPointer = { x: 120, y: 80, hotX: 2, hotY: 3, width: 12, height: 20, image: "" };

describe("captured pointer", () => {
  it("starts where it was captured, shown as the setting says", () => {
    const doc = emptyAnnotations();
    expect(pointerState(doc, captured, false)).toEqual({ shown: false, x: 120, y: 80, scale: 1 });
    expect(pointerState(doc, captured, true)).toEqual({ shown: true, x: 120, y: 80, scale: 1 });
    expect(pointerState(doc, null, true)).toBeNull();
  });

  it("follows the user's edits once there are some, whatever the setting", () => {
    const doc = { ...emptyAnnotations(), pointer: { shown: false, x: 5, y: 6, scale: 2 } };
    expect(pointerState(doc, captured, true)).toEqual({ shown: false, x: 5, y: 6, scale: 2 });
  });

  it("covers its image with the hot spot on its position", () => {
    expect(pointerBox(captured, { shown: true, x: 120, y: 80, scale: 1 })).toEqual({ x: 118, y: 77, width: 12, height: 20 });
    expect(pointerBox(captured, { shown: true, x: 120, y: 80, scale: 2 })).toEqual({ x: 116, y: 74, width: 24, height: 40 });
  });

  it("shows and hides, making no edit when nothing changes", () => {
    const doc = emptyAnnotations();
    const state = pointerState(doc, captured, false)!;
    const shown = showPointer(doc, state, true);
    expect(shown.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1 });
    expect(showPointer(doc, state, false)).toBe(doc);
    const hidden = showPointer(shown, shown.pointer!, false);
    expect(hidden.pointer?.shown).toBe(false);
  });

  it("moves by dragging and resizes keeping its proportions", () => {
    const state = { shown: true, x: 120, y: 80, scale: 1 };
    // Dragged: the node's corner is now at 40, 60.
    expect(transformPointer(captured, state, { x: 40, y: 60, scaleX: 1, scaleY: 1 })).toEqual({ shown: true, x: 42, y: 63, scale: 1 });
    // A corner pulled out to twice the width and a bit more height: twice the size.
    expect(transformPointer(captured, state, { x: 118, y: 77, scaleX: 2, scaleY: 1.5 })).toEqual({ shown: true, x: 122, y: 83, scale: 2 });
    // Never larger than the largest size.
    expect(transformPointer(captured, state, { x: 0, y: 0, scaleX: 100, scaleY: 100 }).scale).toBe(MAX_POINTER_SCALE);
    expect(movePointer(state, -10, 5)).toEqual({ shown: true, x: 110, y: 85, scale: 1 });
    const doc = emptyAnnotations();
    expect(withPointer(doc, state, { ...state })).toBe(doc);
    expect(withPointer(doc, state, movePointer(state, 1, 0)).pointer).toEqual({ shown: true, x: 121, y: 80, scale: 1 });
  });

  it("draws the built-in looks at the capture's density, with their hot spots", () => {
    expect(builtInSprite("arrow", 1)).toEqual({ width: 16, height: 24, hotX: 2, hotY: 2 });
    expect(builtInSprite("hand", 2)).toEqual({ width: 40, height: 48, hotX: 16, hotY: 3 });
    expect(builtInSprite("text", 1)).toEqual({ width: 10, height: 20, hotX: 5, hotY: 10 });
    const svg = decodeURIComponent(builtInImage("hand", 2).replace("data:image/svg+xml;charset=utf-8,", ""));
    expect(svg).toContain('width="40" height="48"');
    expect(svg).toContain('viewBox="0 0 20 24"');
  });

  it("shows the captured image until a look is picked", () => {
    const state = { shown: true, x: 120, y: 80, scale: 1 };
    expect(pointerSprite(captured, state, 2)).toBe(captured);
    expect(pointerImageSource({ ...captured, image: "abc" }, state, 1)).toBe("data:image/png;base64,abc");
    const hand = { ...state, look: "hand" as const };
    expect(pointerSprite(captured, hand, 2)).toEqual(builtInSprite("hand", 2));
    expect(pointerImageSource(captured, hand, 2)).toBe(builtInImage("hand", 2));
  });

  it("keeps the hot spot in place when the look changes", () => {
    const doc = emptyAnnotations();
    const state = { shown: true, x: 120, y: 80, scale: 1.5 };
    const hand = changePointerLook(doc, state, "hand");
    expect(hand.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1.5, look: "hand" });
    // The hand's fingertip sits on the hot spot: its box moves, the point does not.
    expect(pointerBox(builtInSprite("hand", 1), hand.pointer!)).toEqual({ x: 108, y: 77.75, width: 30, height: 36 });
    const back = changePointerLook(hand, hand.pointer!, null);
    expect(back.pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1.5 });
    expect(changePointerLook(back, back.pointer!, null)).toBe(back);
  });

  it("shows a hidden pointer when a look is picked", () => {
    const doc = emptyAnnotations();
    const hidden = pointerState(doc, captured, false)!;
    expect(changePointerLook(doc, hidden, "text").pointer).toEqual({ shown: true, x: 120, y: 80, scale: 1, look: "text" });
  });

  it("keeps the look through moves and resizes, measured on the look's own image", () => {
    const state = { shown: true, x: 120, y: 80, scale: 1, look: "text" as const };
    const sprite = builtInSprite("text", 1);
    expect(transformPointer(sprite, state, { x: 115, y: 70, scaleX: 2, scaleY: 2 })).toEqual({ shown: true, x: 125, y: 90, scale: 2, look: "text" });
    expect(movePointer(state, 1, 1).look).toBe("text");
  });
});
