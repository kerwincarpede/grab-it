import { describe, expect, it } from "vitest";
import { DEFAULT_BACKDROP, emptyAnnotations, type Annotations } from "./model";
import { renderPlan } from "./render";

const size = { width: 400, height: 200 };

describe("renderPlan", () => {
  it("draws an unturned capture whole at its own scale", () => {
    const plan = renderPlan(emptyAnnotations(), size, 2);
    expect(plan.stage).toEqual(size);
    expect(plan.oriented).toBe(false);
    expect(plan.captureScale).toBe(2);
    expect(plan.crop).toEqual({ x: 0, y: 0, ...size });
    expect(plan.measureBorders).toBe(false);
    expect(plan.blurredFill).toBe(false);
    expect(plan.backdropImage).toBeNull();
  });

  it("turns the stage and the crop with the capture", () => {
    const doc: Annotations = { ...emptyAnnotations(), rotation: 90, crop: { x: 0, y: 0, width: 100, height: 50 } };
    const plan = renderPlan(doc, size, 1);
    expect(plan.stage).toEqual({ width: 200, height: 400 });
    expect(plan.oriented).toBe(true);
    expect(plan.crop).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(plan.shownCrop.width).toBe(50);
    expect(plan.shownCrop.height).toBe(100);
  });

  it("falls back to the window's density when the capture does not say", () => {
    expect(renderPlan(emptyAnnotations(), size, null).captureScale).toBe(window.devicePixelRatio || 1);
    expect(renderPlan(emptyAnnotations(), size, Number.NaN).captureScale).toBe(window.devicePixelRatio || 1);
  });

  it("says what the backdrop needs", () => {
    const blurred = renderPlan({ ...emptyAnnotations(), backdrop: { ...DEFAULT_BACKDROP, fill: "blur", balance: true } }, size, 1);
    expect(blurred.blurredFill).toBe(true);
    expect(blurred.measureBorders).toBe(true);
    const pictured = renderPlan({ ...emptyAnnotations(), backdrop: { ...DEFAULT_BACKDROP, fill: "image", image: "/pics/sea.jpg" } }, size, 1);
    expect(pictured.backdropImage).toBe("/pics/sea.jpg");
  });
});
